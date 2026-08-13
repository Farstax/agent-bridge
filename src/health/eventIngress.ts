/**
 * PURPOSE: The one deliberate authenticated ingress boundary approved by
 * issue #347/#351 — accepts a single bounded Farstax health/operations
 * scenario (a health plugin report crossing into `red` status) and starts
 * bounded work through the ordinary owning Run (bridge_runs), executed by
 * the SAME provider-turn execution owner ordinary Telegram-driven turns use
 * (BridgeEngine.executeSurfaceNeutralTurn), with no preceding chat turn. Not a
 * general event bus: only this one event kind is accepted, and
 * authorization comes solely from the authenticated `token`, never from
 * event payload content.
 *
 * Architecture (per the corrected #351 issue body):
 *   external health event
 *     -> authenticated/idempotent durable receipt   (acceptHealthOpsEvent)
 *     -> ordinary owning Run                         (bridge_runs, linked here)
 *     -> main agent + AGENTS.md + Skill + tools       (executeHealthOpsRun)
 *     -> terminal Run/result                          (BridgeEngine.executeSurfaceNeutralTurn + EventStore)
 *     -> receipt correlation                          (reconcileEventReceiptResult)
 *
 * Deliberately does NOT create a work_item/work_job/ops_check job (that was
 * the original, superseded design that recreated the mechanical Worker
 * workflow layer issue #347 removes) and deliberately does NOT reimplement
 * CLI invocation via buildCliInvocation/runCli directly. Instead
 * executeHealthOpsRun calls the engine's surface-neutral wrapper. That
 * wrapper keeps the ordinary provider-attempt owner plus its outer lock
 * heartbeat and continuation lifecycle.
 *
 * The wrapper requires a numeric sentinel chat id, a synthetic chat key, an
 * execution-lane handle, and the existing BridgeEvent collector. Those are
 * data needed by the provider runtime and EventStore. They do not create a
 * Telegram delivery or conversation session. The Run was already created by
 * acceptHealthOpsEvent, so this module only seeds EventStore with that Run.
 *
 * NEIGHBORS: src/db.ts, src/repositories/eventReceiptRepository.ts,
 * src/engine.ts, src/events/store.ts, src/health/scheduler.ts
 */
import { randomUUID } from "node:crypto";
import type { BridgeDb, ExecutionLaneHandle } from "../db.js";
import type { BotKind } from "../types.js";
import type { HealthReport } from "./types.js";
import type { BridgeEngine } from "../engine.js";
import { EventStore } from "../events/store.js";
import type { BridgeEvent } from "../events/types.js";

export const HEALTH_EVENT_SOURCE = "health" as const;
export const HEALTH_OPS_EVENT_KIND_RED = "plugin_status_red" as const;

/** Lock namespace and stable synthetic chat identity for event-originated
 * health runs. Not a Telegram-shaped id — deliberately distinct from any
 * real chat_key so it can never collide with an interactive chat's lane. */
export const HEALTH_RUN_SURFACE = "health" as const;
export const HEALTH_RUN_CHAT_KEY = "health:ops" as const;
export const HEALTH_RUN_AUTHORITY_SCOPE = "health:report-only" as const;
const HEALTH_EVENT_STARTED_SETTING_PREFIX = "health:event-execution-started:";

export function healthEventExecutionStartedKey(receiptId: number): string {
  return `${HEALTH_EVENT_STARTED_SETTING_PREFIX}${receiptId}`;
}

const MAX_PAYLOAD_BYTES = 4096;
const REDACT_KEY_PATTERN = /token|secret|password|passwd|key|authorization|credential|prompt/i;
const REDACTED = "[redacted]";

function redactText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:token|secret|password|passwd|api[_-]?key|authorization|credential)\s*[:=]\s*[^\s,;]+/gi, (match) => {
      const key = match.slice(0, match.search(/[:=]/));
      return `${key}${match.includes("=") ? "=" : ":"} ${REDACTED}`;
    })
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, `https://[redacted]:[redacted]@`);
}

export class UnauthenticatedEventError extends Error {
  constructor() {
    super("event ingress authentication failed");
    this.name = "UnauthenticatedEventError";
  }
}

export class OversizedEventPayloadError extends Error {
  constructor() {
    super(`event payload exceeds ${MAX_PAYLOAD_BYTES} byte bound`);
    this.name = "OversizedEventPayloadError";
  }
}

export interface HealthOpsEventInput {
  /** Caller-supplied external event identity. */
  eventId: string;
  /** Stable dedupe key. Duplicate delivery of the same key must not duplicate work. */
  idempotencyKey: string;
  occurredAt: string;
  /** Only bounded, non-credential fields of the report are read and persisted. */
  report: Pick<HealthReport, "pluginName" | "status" | "summary" | "checks">;
  /** Bearer credential proving this call came from the trusted health authority. */
  token: string;
}

export interface AcceptHealthOpsEventOptions {
  /** Configured shared secret for the health event authority. Absent => always rejects (fail closed). */
  expectedToken: string | undefined;
  now?: () => string;
  runId?: () => string;
  bot?: BotKind;
}

export interface AcceptedHealthOpsEvent {
  receiptId: number;
  /** The ordinary owning Run's bridge_runs.run_id — always present on a
   * successful (non-throwing) return. */
  runId: string;
  /** false when this call resolved to an existing receipt from a prior delivery. */
  created: boolean;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "string") return redactText(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? REDACTED : redactValue(val);
    }
    return out;
  }
  return value;
}

function boundedRedactedPayload(report: HealthOpsEventInput["report"]): string {
  const redacted = redactValue({
    pluginName: report.pluginName,
    status: report.status,
    summary: report.summary,
    checks: report.checks.map((check) => ({ name: check.name, status: check.status, message: check.message })),
  });
  const json = JSON.stringify(redacted);
  if (Buffer.byteLength(json, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new OversizedEventPayloadError();
  }
  return json;
}

type PersistedHealthReport = Pick<HealthReport, "pluginName" | "status" | "summary" | "checks">;

function parsePersistedHealthReport(payloadJson: string): PersistedHealthReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("event receipt payload is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("event receipt payload is not an object");
  const value = parsed as Partial<PersistedHealthReport>;
  if (typeof value.pluginName !== "string" || value.status !== "red" || typeof value.summary !== "string" || !Array.isArray(value.checks)) {
    throw new Error("event receipt payload is not a valid red health report");
  }
  const checks = value.checks.map((check) => {
    if (!check || typeof check !== "object") throw new Error("event receipt check is invalid");
    const item = check as { name?: unknown; status?: unknown; message?: unknown };
    if (typeof item.name !== "string" || typeof item.message !== "string" || (item.status !== "red" && item.status !== "amber" && item.status !== "green")) {
      throw new Error("event receipt check is invalid");
    }
    return { name: item.name, status: item.status as HealthReport["checks"][number]["status"], message: item.message };
  });
  return { pluginName: value.pluginName, status: "red", summary: value.summary, checks };
}

/**
 * Creates (or reuses) the owning Run for a receipt and durably links it,
 * compare-and-swapped on the receipt still being in 'received' status. Safe
 * to call repeatedly for the same receipt id — a receipt that is already
 * linked returns its existing run_id without creating a second Run. This is
 * the restart-safe replay path: if a prior attempt persisted the receipt
 * but crashed before linking a Run, calling this again (with a fresh runId)
 * creates and links exactly one Run for it.
 */
export function ensureLinkedHealthEventRun(
  db: BridgeDb,
  receiptId: number,
  options: Pick<AcceptHealthOpsEventOptions, "runId" | "bot">,
): string {
  return db.runInTransaction(() => {
    const current = db.getEventReceipt(receiptId);
    if (!current) throw new Error(`event receipt ${receiptId} disappeared before Run linking`);
    if (current.run_id) return current.run_id;

    const runId = options.runId ? options.runId() : randomUUID();
    db.insertRun(runId, HEALTH_RUN_CHAT_KEY, options.bot ?? "claude");
    db.linkEventReceiptRun(receiptId, runId);
    return runId;
  });
}

/**
 * Authenticated, idempotent ingress for one bounded scenario: a health
 * plugin report crossing into `red`. Writes the receipt durably before any
 * Run is created, dedupes on idempotencyKey (duplicate delivery returns the
 * existing receipt/Run without creating a second one), and creates exactly
 * one ordinary owning Run (bridge_runs) correlated to the receipt.
 * Authorization comes only from `token` matching the configured authority;
 * event payload content never grants authority or changes the fixed
 * chat key/authority scope this Run is created under.
 *
 * Does not itself execute the CLI turn — see executeHealthOpsRun. Splitting
 * "durably create and correlate the Run" from "execute it" is what makes
 * the restart-safety window precise: a crash before this function returns
 * leaves either no receipt at all (nothing to replay) or a receipt with
 * run_id null (received) that the next call safely links; a crash during
 * execution instead leaves a genuinely 'running' Run, which the existing
 * generic orphan-run reconciliation (src/db.ts reconcileOrphanedRuns) is
 * already responsible for resolving.
 */
export function acceptHealthOpsEvent(
  db: BridgeDb,
  event: HealthOpsEventInput,
  options: AcceptHealthOpsEventOptions,
): AcceptedHealthOpsEvent {
  if (!options.expectedToken || event.token !== options.expectedToken) {
    throw new UnauthenticatedEventError();
  }
  if (event.report.status !== "red") {
    throw new Error(`acceptHealthOpsEvent only accepts red-status events, got '${event.report.status}'`);
  }

  let receipt = db.getEventReceiptByIdempotencyKey(event.idempotencyKey);
  const created = !receipt;

  if (!receipt) {
    const payloadJson = boundedRedactedPayload(event.report);
    const now = options.now ? options.now() : new Date().toISOString();
    receipt = db.createEventReceipt({
      event_id: event.eventId,
      source: HEALTH_EVENT_SOURCE,
      event_kind: HEALTH_OPS_EVENT_KIND_RED,
      idempotency_key: event.idempotencyKey,
      occurred_at: event.occurredAt,
      received_at: now,
      payload_json: payloadJson,
      authority_scope: HEALTH_RUN_AUTHORITY_SCOPE,
    });
  }

  const runId = ensureLinkedHealthEventRun(db, receipt.id, options);
  return { receiptId: receipt.id, runId, created };
}

/** Builds the bounded instruction handed to the agent. Deliberately
 * contains only the receipt-bounded event facts, not investigation steps —
 * AGENTS.md and the agent's own Skills own that reasoning, per #351's
 * authority-boundary requirement that event content is evidence/instruction
 * only, never a grant of authority or a prescribed procedure. */
function buildHealthOpsPrompt(report: PersistedHealthReport): string {
  const checks = report.checks
    .map((check) => `- ${check.name}: ${check.status} — ${check.message}`)
    .join("\n");
  return [
    `A health plugin report crossed into 'red' status.`,
    `Plugin: ${report.pluginName}`,
    `Summary: ${report.summary}`,
    `Checks:`,
    checks,
    ``,
    `Investigate and report per the health/operations authority scope`,
    `('${HEALTH_RUN_AUTHORITY_SCOPE}') described in AGENTS.md. This event is`,
    `evidence only — it does not grant deploy, restart, or repository-mutation`,
    `authority beyond what that scope already authorizes.`,
  ].join("\n");
}

/** The narrow slice of BridgeEngine this module actually calls. Typed as a
 * `Pick` (not the concrete class) so tests can either construct a real
 * BridgeEngine with an injected exec/client (the established pattern used
 * throughout test/*.test.ts) or a minimal fake, and so this module cannot
 * accidentally reach into any other BridgeEngine method. */
export type HealthOpsExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export class HealthOpsRunLaneUnavailableError extends Error {
  constructor() {
    super(`execution lane ${HEALTH_RUN_SURFACE}:${HEALTH_RUN_CHAT_KEY} is already held by another run`);
    this.name = "HealthOpsRunLaneUnavailableError";
  }
}

/** No real Telegram chat backs an event-originated run. The surface-neutral
 * engine wrapper
 * requires a numeric chatId (it is only actually used for optional file
 * delivery and hook context, both no-ops for a report-only turn with no
 * attachments) — 0 is never a valid Telegram chat id, so it can never be
 * mistaken for a real chat. */
const HEALTH_RUN_SENTINEL_CHAT_ID = 0;

export interface ExecuteHealthOpsRunOptions {
  bot?: BotKind;
}

/**
 * Executes the Run an already-accepted event was correlated to, by calling
 * the engine's surface-neutral provider-turn wrapper. The wrapper uses the
 * same provider-turn execution owner ordinary async turns use. This function's own responsibilities are
 * narrow: resolve the receipt -> Run linkage, acquire the dedicated
 * execution lane (fencing two event-originated turns from ever running
 * concurrently), build the bounded/non-prescriptive prompt, and wire a
 * BridgeEvent collector (EventStore) seeded with the already-created Run so
 * executePromptAsync's normal run.started/run.completed/run.failed
 * telemetry persists straight onto that Run — the same terminalization path
 * ordinary turns already rely on, not a reimplementation of it.
 */
export async function executeHealthOpsRun(
  db: BridgeDb,
  receiptId: number,
  engine: HealthOpsExecutionEngine,
  options: ExecuteHealthOpsRunOptions = {},
): Promise<{ runId: string; status: "done" | "failed" }> {
  const receipt = db.getEventReceipt(receiptId);
  if (!receipt || !receipt.run_id) {
    throw new Error(`event receipt ${receiptId} has no linked Run to execute`);
  }
  const runId = receipt.run_id;
  const bot = options.bot ?? "claude";
  const report = parsePersistedHealthReport(receipt.payload_json);

  const laneHandle: ExecutionLaneHandle | null = db.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
  if (!laneHandle) throw new HealthOpsRunLaneUnavailableError();

  try {
    // Authoritative re-check, taken only after the lane is held: a waiter
    // (startup replay racing live dispatch, or a caller that queued behind
    // another owner) can obtain the lane after the Run already reached a
    // terminal or cancelled state. Crossing the provider boundary in that
    // case would invoke the provider a second time for already-finished
    // work, or run it for work that was cancelled while queued. Re-reading
    // here — not relying on the state captured before lane acquisition —
    // is what makes the boundary itself authoritative.
    const eligibleRun = db.getRun(runId);
    if (!eligibleRun || eligibleRun.status !== "running") {
      return { runId, status: eligibleRun?.status === "done" ? "done" : "failed" };
    }
    // The Run being 'running' is not by itself proof this attempt hasn't
    // already reached the provider: a prior attempt for this same
    // receipt/Run can have written the durable provider-start marker and
    // then crashed before its `finally` cleared it. Holding the lane proves
    // no *other live* attempt is using it right now, but not that the prior
    // attempt is dead — only process-liveness reconciliation
    // (startedNonReplayableHealthRuns + reconcileAbandonedHealthLeases) can
    // prove that safely. So a pre-existing marker must also block the
    // provider boundary here, leaving the Run to that reconciliation path
    // rather than risking a second provider invocation.
    if (db.getSetting(healthEventExecutionStartedKey(receiptId)) !== null) {
      return { runId, status: "failed" };
    }

    // Seeded with the existing runId so EventStore recognizes the Run
    // already exists (see its constructor) and never re-inserts it — it
    // only needs to persist the terminal transition from the provider owner
    // reports via `collect`.
    const eventStore = new EventStore(db, runId);
    const collect = (e: BridgeEvent) => {
      if (e.type === "run.completed") eventStore.queueCompleted(e);
      else eventStore.collect(e);
    };
    const eventContext = {
      runId,
      bot,
      chatId: HEALTH_RUN_CHAT_KEY,
      threadId: undefined,
      serviceId: laneHandle.serviceId,
      acquisitionId: laneHandle.acquisitionId,
    };

    try {
      await engine.executeSurfaceNeutralTurn({
        prompt: buildHealthOpsPrompt(report),
        sessionId: null,
        chatId: HEALTH_RUN_SENTINEL_CHAT_ID,
        chatKey: HEALTH_RUN_CHAT_KEY,
        laneHandle,
        runId,
        eventContext,
        collect,
        finalize: () => eventStore.finalize(),
        onProviderExecutionStarted: () => {
          db.setSetting(healthEventExecutionStartedKey(receiptId), runId);
        },
      });
    } finally {
      // Flushes the deferred run.completed persistence queued above (see
      // EventStore.finalize()). Safe to call even when executePromptAsync
      // threw before ever queuing one.
      eventStore.finalize();
    }
  } catch (err) {
    // The provider owner can throw via a code path that never emitted a
    // run.failed BridgeEvent (e.g. a thrown ExecutionLockLostError before
    // any provider invocation). The CAS-guarded updateRunFailed (see
    // runRepository.ts) makes this a safe, idempotent fallback rather than
    // a duplicate/competing terminal writer: if run.failed already applied,
    // this is a no-op.
    db.updateRunFailed(runId, (err as Error).message);
  } finally {
    db.setSetting(healthEventExecutionStartedKey(receiptId), null);
    db.unlock(laneHandle);
  }

  const run = db.getRun(runId);
  return { runId, status: run?.status === "done" ? "done" : "failed" };
}

/**
 * Reclaims accepted health receipts during startup. A receipt without a Run
 * is the durable receipt-before-link crash window; a linked receipt is only
 * replayed when no provider-attempt marker exists. The marker is written by
 * BridgeEngine at the provider boundary, so a restart never blindly repeats
 * an attempt that may already have reached the provider.
 */
export async function resumeDurablePendingHealthEvents(
  db: BridgeDb,
  engine: HealthOpsExecutionEngine,
  options: ExecuteHealthOpsRunOptions = {},
): Promise<void> {
  for (const pending of db.listPendingEventReceipts()) {
    if (pending.source !== HEALTH_EVENT_SOURCE) continue;
    if (db.getSetting(healthEventExecutionStartedKey(pending.id)) !== null) continue;
    if (!pending.run_id) {
      ensureLinkedHealthEventRun(db, pending.id, { bot: options.bot });
    }
    for (;;) {
      try {
        await executeHealthOpsRun(db, pending.id, engine, options);
        reconcileEventReceiptResult(db, pending.id);
        break;
      } catch (error) {
        if (error instanceof HealthOpsRunLaneUnavailableError) {
          // The receipt remains durable and unmarked while waiting. A
          // process crash here is therefore restart-safe; a live process
          // simply retries the same Run after the owner releases the lane.
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        reconcileEventReceiptResult(db, pending.id);
        break;
      }
    }
  }
}

/**
 * Restart-safe reconciliation: reflects the receipt's status/result/error
 * from the authoritative bridge_runs state. Safe to call repeatedly (e.g.
 * after a process restart) — it never creates or re-executes work, and the
 * underlying Run terminal-state transitions are themselves CAS-guarded on
 * status = 'running' (runRepository.ts).
 */
export function reconcileEventReceiptResult(db: BridgeDb, receiptId: number): void {
  const receipt = db.getEventReceipt(receiptId);
  if (!receipt || receipt.run_id == null) return;
  const run = db.getRun(receipt.run_id);
  if (!run) return;

  if (run.status === "done") {
    db.recordEventReceiptResult(receipt.id, {
      status: "completed",
      result_reference: `run:${run.run_id}`,
      error_class: null,
    });
  } else if (run.status === "failed") {
    db.recordEventReceiptResult(receipt.id, {
      status: "failed",
      result_reference: `run:${run.run_id}`,
      error_class: "run_failed",
    });
  } else if (run.status === "cancelled") {
    db.recordEventReceiptResult(receipt.id, {
      status: "cancelled",
      result_reference: `run:${run.run_id}`,
      error_class: "run_cancelled",
    });
  }
  // running: still in flight, receipt stays at 'run_created'.
}
