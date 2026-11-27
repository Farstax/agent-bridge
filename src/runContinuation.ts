/**
 * PURPOSE: Durable, bounded continuation requests for ordinary interactive Runs.
 * A provider can yield while required external work is still pending and Agent Bridge
 * will admit one later ordinary Run against the same conversation/provider session.
 * This is intentionally not a scheduler or workflow engine.
 */
import type { BridgeDb, ExecutionLaneHandle } from "./db.js";
import { randomUUID } from "node:crypto";
import type { InteractiveTurnInput } from "./interactiveIngress.js";
import type { RouteableBotKind } from "./types.js";
import { lookupProviderSession, lookupProviderSessionRunId } from "./providers/sessionRuntime.js";
import { getRunOwnedProcessState } from "./runOwnedProcesses.js";

export const RUN_CONTINUATION_PREFIX = "run-continuation:v1:";
export const OUTWARD_RUN_ACCEPTED_TURN_PREFIX = "outward-run-accepted-turn:v1:";
const PREFIX = RUN_CONTINUATION_PREFIX;
const DEFAULT_SCAN_MS = 5_000;
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 30 * 60;
const MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
/** An explicit future wake may be requested up to one week ahead; it is for unfinished work, not a routine. */
const MAX_WAKE_HORIZON_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CAPACITY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_REASON_CHARS = 500;
/** Hard cap on consecutive agent-initiated continuations since the last independently authorised task origin. */
export const MAX_CONSECUTIVE_AGENT_CONTINUATIONS = 20;
const LIMIT_NOTICE_PREFIX = "run-continuation-limit:v1:";

export class RunContinuationLimitError extends Error {
  constructor() {
    super(`automatic continuation limit reached (${MAX_CONSECUTIVE_AGENT_CONTINUATIONS} consecutive agent-initiated continuations); stop and ask the owner for further input`);
    this.name = "RunContinuationLimitError";
  }
}

export type RunContinuationState = "pending" | "claimed" | "completed" | "failed" | "expired" | "cancelled";

export type ContinuationDispatchOutcome = "committed" | "queued" | "failed" | "fenced" | "deferred" | void | boolean;

export interface RolloutProvenance {
  reconciledAt: string;
  reason: string;
  reconciliationAuditId: string;
  originRunId: string;
  surfaceIdentity: string;
  chatKey: string;
  provider: RouteableBotKind;
}

export interface RunContinuation {
  version: 1;
  id: string;
  originRunId: string;
  surfaceIdentity: string;
  chatKey: string;
  provider: RouteableBotKind;
  reason: string;
  requestedAt: string;
  dueAt: string;
  expiresAt: string;
  state: RunContinuationState;
  claimedAt?: string;
  claimRunId?: string;
  /** Unique acquisition generation within a continuation-runner process. */
  claimToken?: string;
  claimExpiresAt?: string;
  completedAt?: string;
  error?: string;
  delivery?: { chatId: string | number; chatType: string; threadId?: string | number };
  rolloutProvenance?: RolloutProvenance;
  /** Qualified accepted origin captured before a controlled OSS rollout fence. */
  rolloutRecoveryOnly?: true;
  recoveryOriginalTurnId?: number;
  /** Ordinary continuation run admitted after its durable queue handoff. */
  successorRunId?: string;
  /**
   * Consecutive agent-initiated continuations in this chain, including this one.
   * A capacity wait carries its origin Run's depth unchanged. Absent on legacy records.
   */
  depth?: number;
  /** A settled capacity rejection may re-enter the existing fallback path. */
  capacityWait?: true;
  /** The initial capacity notice is a durable one-shot delivery decision. */
  capacityNoticeSent?: true;
  /** Original queue receipt retained through capacity recovery. */
  retainedPendingMessageIds?: number[];
  /** An ACP-v1 deferred Workstream payload. The existing settings-backed
   * continuation record owns the original admitted input; no second queue or
   * transcript database is introduced. */
  outward?: { sessionId: string; prompt: string; attachmentCount: number; receiptKey?: string; ordinaryContinuations?: true };
  /** Authorised ordinary Desk wake binds this persisted Workstream, never chatKey guessing. */
  outwardSessionId?: string;
  /** Selection generation captured when this outward wake was requested. */
  selectionRevision?: number;
  /** The task was retired due to capacity expiry and awaits final notification. */
  expiryDeliveryPending?: true;
}

export interface RequestRunContinuationInput {
  /** Stable logical-task key for a capacity wait; ordinary continuations use their Run id. */
  continuationId?: string;
  originRunId: string;
  surfaceIdentity: string;
  chatKey: string;
  provider: RouteableBotKind;
  reason: string;
  /** Exactly one of afterSeconds or dueAtMs selects the wake time. */
  afterSeconds?: number;
  /** Absolute one-shot wake instant (epoch ms). Expiry is measured from this instant. */
  dueAtMs?: number;
  /** Transport delivery coordinates, persisted as-is at request time. Omit only for legacy/test callers that rely on the one-time decode fallback in parse(). */
  delivery?: { chatId: string | number; chatType: string; threadId?: string | number };
  capacityWait?: boolean;
  retainedPendingMessageIds?: number[];
  outward?: { sessionId: string; prompt: string; attachmentCount: number; receiptKey?: string; ordinaryContinuations?: true };
  /** Authoritative Workstream binding for ordinary outward ACP continuations. */
  outwardSessionId?: string;
}

export function outwardSelectionRevisionKey(chatKey: string): string {
  return `outward-selection-revision:v1:${JSON.stringify(chatKey)}`;
}

export function outwardSelectionRevision(db: BridgeDb, chatKey: string): number {
  const raw = db.getSetting(outwardSelectionRevisionKey(chatKey));
  if (raw === null || raw === undefined) return 0;
  const revision = Number(raw);
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid outward selection revision");
  return revision;
}

function key(id: string): string {
  return `${PREFIX}${id}`;
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

/**
 * Chain depth of a Run: the depth of the continuation record it was admitted
 * from, or 0 for a Run with no continuation provenance (an owner message,
 * scheduled routine or other independently authorised origin). The engine links
 * a continuation to its successor Run at admission, before the provider runs.
 */
function runChainDepth(db: BridgeDb, runId: string): number {
  const rows = db.raw.prepare("SELECT value FROM settings WHERE key LIKE ?").all(`${PREFIX}%`) as Array<{ value: string }>;
  let depth = 0;
  for (const row of rows) {
    const record = parse(row.value);
    if (record?.successorRunId === runId) depth = Math.max(depth, record.depth ?? 0);
  }
  return depth;
}

function parse(value: string): RunContinuation | null {
  try {
    const candidate = JSON.parse(value) as RunContinuation;
    if (
      candidate?.version !== 1
      || !candidate.id
      || !candidate.originRunId
      || !candidate.surfaceIdentity
      || !candidate.chatKey
      || !candidate.provider
      || !candidate.reason
      || !["pending", "claimed", "completed", "failed", "expired", "cancelled"].includes(candidate.state)
    ) return null;
    if (candidate.selectionRevision !== undefined && (!Number.isSafeInteger(candidate.selectionRevision) || candidate.selectionRevision < 0)) return null;
    if (candidate.depth !== undefined && (!Number.isSafeInteger(candidate.depth) || candidate.depth < 0)) return null;
    if (candidate.capacityWait !== undefined && candidate.capacityWait !== true) return null;
    if (candidate.rolloutRecoveryOnly !== undefined && candidate.rolloutRecoveryOnly !== true) return null;
    if (candidate.recoveryOriginalTurnId !== undefined
      && (!Number.isSafeInteger(candidate.recoveryOriginalTurnId) || candidate.recoveryOriginalTurnId < 1)) return null;
    if (candidate.rolloutRecoveryOnly && (candidate.surfaceIdentity !== "acp:outward" || !candidate.outwardSessionId
      || !candidate.recoveryOriginalTurnId || candidate.capacityWait)) return null;
    if (candidate.capacityNoticeSent !== undefined && candidate.capacityNoticeSent !== true) return null;
    if (candidate.expiryDeliveryPending !== undefined && candidate.expiryDeliveryPending !== true) return null;
    if (candidate.claimToken !== undefined && (typeof candidate.claimToken !== "string" || !candidate.claimToken)) return null;
    if (candidate.retainedPendingMessageIds !== undefined && (!Array.isArray(candidate.retainedPendingMessageIds) || candidate.retainedPendingMessageIds.some((id) => !Number.isSafeInteger(id) || id < 1))) return null;
    if (candidate.successorRunId !== undefined && typeof candidate.successorRunId !== "string") return null;
    if (candidate.outwardSessionId !== undefined && (
      candidate.surfaceIdentity !== "acp:outward" || candidate.capacityWait === true ||
      typeof candidate.outwardSessionId !== "string" || !candidate.outwardSessionId ||
      candidate.outwardSessionId.length > 256
    )) return null;
    if (candidate.outward !== undefined && (
      candidate.surfaceIdentity !== "acp:outward" || candidate.capacityWait !== true ||
      typeof candidate.outward.sessionId !== "string" || !candidate.outward.sessionId ||
      candidate.outward.sessionId.length > 256 ||
      typeof candidate.outward.prompt !== "string" || candidate.outward.prompt.length > 160_000 ||
      !Number.isSafeInteger(candidate.outward.attachmentCount) ||
      candidate.outward.attachmentCount < 0 || candidate.outward.attachmentCount > 8 ||
      (candidate.outward.receiptKey !== undefined && (typeof candidate.outward.receiptKey !== "string" || candidate.outward.receiptKey.length > 512))
      || (candidate.outward.ordinaryContinuations !== undefined && candidate.outward.ordinaryContinuations !== true)
    )) return null;
    if (candidate.rolloutProvenance) {
      const p = candidate.rolloutProvenance;
      if (
        !p
        || typeof p.reconciledAt !== "string"
        || typeof p.reason !== "string"
        || typeof p.reconciliationAuditId !== "string"
        || typeof p.originRunId !== "string"
        || typeof p.surfaceIdentity !== "string"
        || typeof p.chatKey !== "string"
        || typeof p.provider !== "string"
      ) return null;
    }
    if ((candidate.outward || candidate.outwardSessionId) && candidate.surfaceIdentity === "acp:outward") return candidate;
    if (candidate.delivery) return candidate;
    if (candidate.surfaceIdentity.startsWith("telegram:")) {
      const match = /^(-?\d+)(?::(\d+))?$/.exec(candidate.chatKey);
      if (!match) return null;
      const chatId = match[1];
      const threadId = match[2];
      return {
        ...candidate,
        delivery: {
          chatId: Number(chatId),
          chatType: Number(chatId) < 0 ? "supergroup" : "private",
          ...(threadId === undefined ? {} : { threadId: Number(threadId) }),
        },
      };
    }
    if (candidate.surfaceIdentity.startsWith("discord:")) return { ...candidate, delivery: { chatId: candidate.chatKey, chatType: "private" } };
    return null;
  } catch {
    return null;
  }
}

export function requestRunContinuation(
  db: BridgeDb,
  input: RequestRunContinuationInput,
  nowMs = Date.now(),
): RunContinuation {
  if ((input.afterSeconds === undefined) === (input.dueAtMs === undefined)) {
    throw new Error("specify either after-seconds or an explicit wake time");
  }
  if (input.dueAtMs !== undefined) {
    if (input.capacityWait) throw new Error("a capacity wait cannot use an explicit wake time");
    if (!Number.isInteger(input.dueAtMs) || input.dueAtMs < nowMs + MIN_DELAY_SECONDS * 1_000 || input.dueAtMs > nowMs + MAX_WAKE_HORIZON_MS) {
      throw new Error(`wake time must be between ${MIN_DELAY_SECONDS} seconds and 7 days from now`);
    }
  } else {
    const maximumDelay = input.capacityWait ? MAX_CAPACITY_LIFETIME_MS / 1_000 : MAX_DELAY_SECONDS;
    if (!Number.isInteger(input.afterSeconds) || input.afterSeconds! < MIN_DELAY_SECONDS || input.afterSeconds! > maximumDelay) {
      throw new Error(`after-seconds must be an integer between ${MIN_DELAY_SECONDS} and ${maximumDelay}`);
    }
  }
  if (input.outward && (
    !input.capacityWait || input.surfaceIdentity !== "acp:outward" ||
    !input.outward.sessionId || input.outward.sessionId.length > 256 ||
    input.outward.prompt.length > 160_000 ||
    !Number.isSafeInteger(input.outward.attachmentCount) || input.outward.attachmentCount < 0 ||
    input.outward.attachmentCount > 8 ||
    (input.outward.receiptKey !== undefined && (typeof input.outward.receiptKey !== "string" || input.outward.receiptKey.length > 512))
    || (input.outward.ordinaryContinuations !== undefined && input.outward.ordinaryContinuations !== true)
  )) throw new Error("invalid outward ACP continuation payload");
  if (input.outwardSessionId !== undefined && (
    input.surfaceIdentity !== "acp:outward" || input.capacityWait || input.outward ||
    !input.outwardSessionId || input.outwardSessionId.length > 256
  )) throw new Error("invalid outward ordinary Workstream binding");
  const originRunId = bounded(input.originRunId, "origin run id", 200);
  const surfaceIdentity = bounded(input.surfaceIdentity, "surface identity", 160);
  const chatKey = bounded(input.chatKey, "chat key", 200);
  const reason = bounded(input.reason, "reason", MAX_REASON_CHARS);
  const provider = bounded(String(input.provider), "provider", 80) as RouteableBotKind;
  const requestedAt = new Date(nowMs).toISOString();
  const dueMs = input.dueAtMs ?? nowMs + input.afterSeconds! * 1_000;
  const dueAt = new Date(dueMs).toISOString();
  // An explicit wake keeps the ordinary two-hour admission grace, counted from
  // the chosen instant so a valid future wake can never expire before it is due.
  const proposedExpiresAt = new Date(input.dueAtMs !== undefined
    ? dueMs + MAX_LIFETIME_MS
    : nowMs + (input.capacityWait ? MAX_CAPACITY_LIFETIME_MS : MAX_LIFETIME_MS)).toISOString();
  const id = bounded(input.continuationId ?? originRunId, "continuation id", 240);
  const originRun = db.getRun(originRunId);
  if (originRun) {
    if (originRun.status !== "running" && !(input.capacityWait && originRun.status === "failed")) throw new Error("originating Run is no longer active");
    if (originRun.surface_identity !== surfaceIdentity) throw new Error("originating Run surface mismatch");
    if (originRun.chat_id !== chatKey) throw new Error("originating Run conversation mismatch");
    if (originRun.bot !== provider) throw new Error("originating Run provider mismatch");
  }

  return db.runInTransaction(() => {
    const existingRow = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const existing = existingRow ? parse(existingRow.value) : null;
    if (existing?.state === "claimed" && !(input.capacityWait && existing.capacityWait)) throw new Error("continuation already claimed for this Run");
    if (input.capacityWait && existing?.capacityWait && (
      existing.surfaceIdentity !== surfaceIdentity || existing.chatKey !== chatKey
    )) throw new Error("capacity wait task identity changed");
    // The depth is decided inside the same transaction that persists the
    // record, so racing requests cannot both slip under the cap.
    const parentDepth = runChainDepth(db, originRunId);
    const depth = input.capacityWait ? (existing?.depth ?? parentDepth) : (existing?.depth ?? parentDepth + 1);
    if (!input.capacityWait && !existing && depth > MAX_CONSECUTIVE_AGENT_CONTINUATIONS) throw new RunContinuationLimitError();
    const continuation: RunContinuation = {
      version: 1,
      id,
      originRunId,
      depth,
      surfaceIdentity,
      chatKey,
      provider,
      reason,
      requestedAt,
      dueAt,
      // A capacity retry represents one admitted task.  Rejections may move
      // its wake time but must never grant it a fresh seven-day lifetime.
      expiresAt: input.capacityWait && existing?.capacityWait ? existing.expiresAt : proposedExpiresAt,
      state: "pending",
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.capacityWait ? { capacityWait: true as const } : {}),
      ...(input.outward ? { outward: input.outward } : existing?.outward ? { outward: existing.outward } : {}),
      ...(input.outwardSessionId ? { outwardSessionId: input.outwardSessionId,
        ...(!existing ? { selectionRevision: outwardSelectionRevision(db, chatKey) }
          : existing.selectionRevision !== undefined ? { selectionRevision: existing.selectionRevision } : {}) } : {}),
      ...(existing?.capacityNoticeSent ? { capacityNoticeSent: true as const } : {}),
      ...(input.capacityWait && (input.retainedPendingMessageIds?.length || existing?.retainedPendingMessageIds?.length)
        ? { retainedPendingMessageIds: input.retainedPendingMessageIds ?? existing!.retainedPendingMessageIds! }
        : {}),
    };
    const persisted = parse(JSON.stringify(continuation));
    if (!persisted) throw new Error("continuation delivery coordinates are invalid");
    db.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key(id), JSON.stringify(persisted));
    return persisted;
  });
}

/**
 * Durable owner-notice request, keyed by conversation rather than Run so a
 * provider-fallback or retry Run (a new Run id) can still deliver it. It is
 * removed only after the notice was sent (at-least-once).
 */
export function recordContinuationLimitNotice(db: BridgeDb, runId: string, surfaceIdentity: string, chatKey: string): void {
  db.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(`${LIMIT_NOTICE_PREFIX}${surfaceIdentity}:${chatKey}`, JSON.stringify({ runId, at: new Date().toISOString() }));
}

const LIMIT_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export function peekContinuationLimitNotice(db: BridgeDb, surfaceIdentity: string, chatKey: string, nowMs = Date.now()): { runId: string } | null {
  const noticeKey = `${LIMIT_NOTICE_PREFIX}${surfaceIdentity}:${chatKey}`;
  const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(noticeKey) as { value: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { runId?: string; at?: string };
    if (parsed.runId && parsed.at && nowMs - Date.parse(parsed.at) <= LIMIT_NOTICE_MAX_AGE_MS) return { runId: parsed.runId };
  } catch { /* fall through to discard */ }
  db.raw.prepare("DELETE FROM settings WHERE key = ?").run(noticeKey);
  return null;
}

export function clearContinuationLimitNotice(db: BridgeDb, surfaceIdentity: string, chatKey: string): void {
  db.raw.prepare("DELETE FROM settings WHERE key = ?").run(`${LIMIT_NOTICE_PREFIX}${surfaceIdentity}:${chatKey}`);
}

/** Mark before external delivery so a restart cannot emit a second wait notice. */
export function claimCapacityWaitNotice(db: BridgeDb, id: string): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current?.capacityWait || current.capacityNoticeSent) return false;
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...current, capacityNoticeSent: true }), key(id));
    return true;
  });
}

export function listRunContinuations(db: BridgeDb, surfaceIdentity?: string): RunContinuation[] {
  const rows = db.raw.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key ASC")
    .all(`${PREFIX}%`) as Array<{ value: string }>;
  return rows
    .map((row) => parse(row.value))
    .filter((item): item is RunContinuation => !!item)
    .filter((item) => surfaceIdentity === undefined || item.surfaceIdentity === surfaceIdentity);
}

/** A pending or claimed capacity wait owns its lane until settled or cancelled. */
export function hasPendingCapacityWait(
  db: BridgeDb,
  surfaceIdentity: string,
  chatKey: string,
  excludingContinuationId?: string,
): boolean {
  return listRunContinuations(db, surfaceIdentity).some((continuation) =>
    continuation.capacityWait === true
    && continuation.chatKey === chatKey
    && (continuation.state === "pending" || continuation.state === "claimed")
    && (!excludingContinuationId || continuation.id !== excludingContinuationId));
}

export interface ClaimRunContinuationOptions {
  runId?: string;
  leaseMs?: number;
  isProcessAlive?: (runId: string) => boolean;
  onCapacityExpired?: (continuation: RunContinuation) => Promise<void> | void;
  /** Test/embedding override; production uses a fresh token for each acquisition. */
  claimToken?: string;
}

function capacitySuccessorFailure(db: BridgeDb, wait: RunContinuation): "failed" | "cancelled" | null {
  if (!wait.successorRunId || (!wait.outward && (!wait.retainedPendingMessageIds?.length ||
      db.hasAnyPendingMessageId(wait.surfaceIdentity, wait.chatKey, wait.retainedPendingMessageIds)))) return null;
  const run = db.getRun(wait.successorRunId);
  if (!run || run.surface_identity !== wait.surfaceIdentity || run.chat_id !== wait.chatKey) return null;
  return run.status === "failed" || run.status === "cancelled" ? run.status : null;
}

/** A receipt disappearing is ambiguous unless its correlated successor actually completed. */
function capacityCompletionProven(db: BridgeDb, wait: RunContinuation): boolean {
  if (!wait.successorRunId || (!wait.outward && !wait.retainedPendingMessageIds?.length)) return false;
  const run = db.getRun(wait.successorRunId);
  return run?.status === "done" && run.surface_identity === wait.surfaceIdentity && run.chat_id === wait.chatKey
    && (wait.outward !== undefined || !db.hasAnyPendingMessageId(wait.surfaceIdentity, wait.chatKey, wait.retainedPendingMessageIds!));
}

/** Accept only one exact persisted user turn with no later instructions. */
export function acceptedRecoveryTurn(db: BridgeDb, wake: Pick<RunContinuation,
  "surfaceIdentity" | "chatKey" | "provider" | "recoveryOriginalTurnId">): { id: number; text: string } | null {
  if (!wake.recoveryOriginalTurnId || wake.surfaceIdentity !== "acp:outward") return null;
  return db.getAcceptedOutwardTurn(wake.chatKey, wake.provider, wake.recoveryOriginalTurnId);
}

/**
 * A failed rollout origin can be resumed only in its original Workstream and
 * provider. The exact native session is reusable only if a previously DONE
 * Run proved it before interruption. With no native binding the existing
 * provider engine can start a fresh inspection-first session. An ambiguous
 * native binding never gets cleared or silently replaced.
 */
export function rolloutRecoveryProviderAuthority(
  db: BridgeDb,
  wake: RunContinuation,
): { providerSessionId?: string; rolloutRecovery: true } | null {
  if (!wake.rolloutRecoveryOnly || !wake.rolloutProvenance || !acceptedRecoveryTurn(db, wake)
    || wake.state !== "claimed" || !wake.claimToken || wake.surfaceIdentity !== "acp:outward") return null;
  const audit = provenPostRolloutAudit(db, wake.originRunId);
  if (!audit || audit.id !== wake.rolloutProvenance.reconciliationAuditId
    || getRunOwnedProcessState(wake.originRunId) !== "absent") return null;
  if (db.raw.prepare("SELECT 1 FROM settings WHERE key IN (?, ?) LIMIT 1")
    .get(`outward-stop-fence:${wake.chatKey}`, `outward-cancel:${wake.originRunId}`)) return null;
  const origin = db.getRun(wake.originRunId);
  if (!origin || origin.status !== "failed" || origin.error !== "interrupted_by_controlled_rollout"
    || origin.surface_identity !== wake.surfaceIdentity
    || origin.chat_id !== wake.chatKey || origin.bot !== wake.provider) return null;
  const bound = lookupProviderSession(db, {
    surfaceIdentity: wake.surfaceIdentity, chatKey: wake.chatKey,
  }, wake.provider);
  if (!bound) return { rolloutRecovery: true };
  const previouslySettled = db.raw.prepare(`
    SELECT 1 FROM bridge_runs WHERE session_id = ? AND status = 'done'
      AND surface_identity = ? AND chat_id = ? AND bot = ?
      AND started_at < ? AND ended_at <= ? LIMIT 1
  `).get(bound, wake.surfaceIdentity, wake.chatKey, wake.provider,
    origin.started_at, origin.started_at);
  return previouslySettled ? { providerSessionId: bound, rolloutRecovery: true } : null;
}

/** A manually reselected origin may have a new binding proven by a completed Run. */
export function provenReselectedOriginBinding(db: BridgeDb, wake: RunContinuation, sessionId: string | null): boolean {
  if (!sessionId || !wake.outwardSessionId || wake.selectionRevision === undefined ||
      outwardSelectionRevision(db, wake.chatKey) <= wake.selectionRevision || !acceptedContinuationObjective(db, wake)) return false;
  const preference = db.raw.prepare("SELECT interactive_cli_preference AS pref FROM bridge_state WHERE surface_identity = ? AND chat_id = ?")
    .get(wake.surfaceIdentity, wake.chatKey) as { pref: string | null } | undefined;
  if (preference?.pref !== wake.provider) return false;
  if (wake.provider === "custom-acp") return false;
  const bindingRunId = lookupProviderSessionRunId(db, { surfaceIdentity: wake.surfaceIdentity, chatKey: wake.chatKey }, wake.provider);
  if (!bindingRunId || bindingRunId === wake.originRunId) return false;
  const run = db.getRun(bindingRunId);
  return Boolean(run && run.surface_identity === wake.surfaceIdentity && run.chat_id === wake.chatKey &&
    run.bot === wake.provider && run.session_id === sessionId && run.status === "done");
}

/**
 * The wake's native binding is still authorised: the origin session, a binding
 * re-established by a completed Run after deliberate reselection, or no binding
 * after a deliberate switch whose accepted objective is durably linked.
 */
export function ordinaryWakeBindingAuthorised(db: BridgeDb, wake: RunContinuation,
  originSessionId: string | null | undefined, boundSessionId: string | null): boolean {
  if (!originSessionId) return false;
  if (boundSessionId === originSessionId) return true;
  const switched = Boolean(wake.outwardSessionId) && wake.selectionRevision !== undefined &&
    outwardSelectionRevision(db, wake.chatKey) > wake.selectionRevision;
  if (switched && !boundSessionId) return Boolean(acceptedContinuationObjective(db, wake));
  return provenReselectedOriginBinding(db, wake, boundSessionId);
}

/** Follow durable successor links to the Run holding the accepted-turn link, never timestamps. */
function acceptedObjectiveRunId(db: BridgeDb, wake: RunContinuation): string | null {
  if (wake.surfaceIdentity !== "acp:outward" || !wake.outwardSessionId) return null;
  let runId = wake.originRunId;
  const seen = new Set<string>();
  while (!seen.has(runId) && seen.size <= MAX_CONSECUTIVE_AGENT_CONTINUATIONS) {
    seen.add(runId);
    const run = db.getRun(runId);
    if (!run || run.surface_identity !== wake.surfaceIdentity || run.chat_id !== wake.chatKey) return null;
    if (db.getSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + runId)) return runId;
    const parents = listRunContinuations(db, wake.surfaceIdentity).filter((parent) =>
      !parent.capacityWait && parent.successorRunId === runId && parent.chatKey === wake.chatKey &&
      parent.outwardSessionId === wake.outwardSessionId);
    if (parents.length !== 1) return null;
    runId = parents[0].originRunId;
  }
  return null;
}

export function acceptedContinuationObjective(db: BridgeDb, wake: RunContinuation): { id: number; text: string } | null {
  const runId = acceptedObjectiveRunId(db, wake);
  const link = runId ? db.getSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + runId) : null;
  if (!link || !/^[1-9][0-9]*$/.test(link)) return null;
  const turn = db.raw.prepare("SELECT id, text FROM conversation_turns WHERE id = ? AND chat_key = ? AND surface_identity = ? AND role = 'user'")
    .get(Number(link), wake.chatKey, wake.surfaceIdentity) as { id: number; text: string } | undefined;
  if (!turn?.text?.trim() || turn.text.length > 160_000 || /^\/(?:stop|cancel|reset)(?:\s|$)/i.test(turn.text)) return null;
  return turn;
}

/** Retire accepted-turn provenance once no live ordinary wake still traces to it. */
function retireAcceptedObjectiveLink(db: BridgeDb, settled: RunContinuation): void {
  const rootRunId = acceptedObjectiveRunId(db, settled);
  if (!rootRunId || db.getRun(rootRunId)?.status === "running") return;
  const live = listRunContinuations(db, settled.surfaceIdentity).some((wake) => wake.id !== settled.id &&
    !wake.capacityWait && wake.chatKey === settled.chatKey && (wake.state === "pending" || wake.state === "claimed") &&
    acceptedObjectiveRunId(db, wake) === rootRunId);
  if (!live) db.raw.prepare("DELETE FROM settings WHERE key = ?").run(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + rootRunId);
}

/** Strictly attribute an interrupted Run to exactly one accepted user turn. */
function originalAcceptedTurnId(db: BridgeDb, origin: { run_id: string },
  wake: Pick<RunContinuation, "chatKey" | "provider">): number | null {
  const linked = db.raw.prepare("SELECT value FROM settings WHERE key = ?")
    .get(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + origin.run_id) as { value: string } | undefined;
  if (!linked || !/^[1-9][0-9]*$/.test(linked.value)) return null;
  const id = Number(linked.value);
  return db.getAcceptedOutwardTurn(wake.chatKey, wake.provider, id)?.id ?? null;
}

/**
 * Resolve completed, single-origin rollout audit only AFTER the release fence
 * has gone. Never modify an existing continuation inside the fenced offline
 * reconciliation phase; a healthy restart (or independently verified rollback)
 * is the only owner allowed to resume durable work.
 */
function provenPostRolloutAudit(db: BridgeDb, originRunId: string): { id: string; completedAt: string } | null {
  if (db.raw.prepare("SELECT 1 FROM settings WHERE key = 'agent-bridge:idle-maintenance:v1'").get()) return null;
  const audits = db.raw.prepare(`
    SELECT id, completed_at AS completedAt, before_json AS beforeJson
    FROM reconciliation_audit WHERE kind = 'run' AND subject_id = ?
      AND status = 'completed' AND reason = 'interrupted_by_controlled_rollout'
    ORDER BY created_at DESC LIMIT 2
  `).all(originRunId) as Array<{ id: string; completedAt: string | null; beforeJson: string }>;
  if (audits.length !== 1 || !audits[0].completedAt || !Number.isFinite(Date.parse(audits[0].completedAt))) return null;
  try {
    const proof = JSON.parse(audits[0].beforeJson) as { containmentState?: unknown; processState?: unknown };
    if (proof.containmentState !== "proven" || proof.processState !== "absent") return null;
  } catch { return null; }
  return { id: audits[0].id, completedAt: audits[0].completedAt };
}

export function claimDueRunContinuation(
  db: BridgeDb,
  id: string,
  nowMs = Date.now(),
  options?: ClaimRunContinuationOptions,
): RunContinuation | null {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current) return null;
    const isPending = current.state === "pending";
    const isClaimedCapacity = current.state === "claimed" && current.capacityWait === true;
    if (!isPending && !isClaimedCapacity) return null;

    if (Date.parse(current.expiresAt) <= nowMs) {
      if (current.capacityWait) return null;
      const expired = { ...current, state: "expired" as const };
      if (current.outwardSessionId) retireAcceptedObjectiveLink(db, current);
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(expired), key(id));
      return null;
    }
    const cancel = (error: string, terminalState: "cancelled" | "failed" = "cancelled"): null => {
      const cancelled: RunContinuation = {
        ...current,
        state: terminalState,
        completedAt: new Date(nowMs).toISOString(),
        error,
      };
      if (current.outwardSessionId && !current.capacityWait) retireAcceptedObjectiveLink(db, current);
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(cancelled), key(id));
      return null;
    };

    const originRun = db.getRun(current.originRunId);
    if (!originRun) return null;
    if (current.outwardSessionId && originRun.status === "failed"
      && originRun.error === "interrupted_by_controlled_rollout"
      && (originRun.outcome_status === "complete" || originRun.outcome_status === "blocked")) {
      return cancel("originating objective already has a terminal provider disposition");
    }
    if (current.rolloutRecoveryOnly && originRun.status === "done") return cancel("originating objective completed normally");
    if (current.rolloutRecoveryOnly && (originRun.status === "cancelled"
      || (originRun.status === "failed" && originRun.error !== "interrupted_by_controlled_rollout"))) {
      return cancel("originating objective was cancelled or not interrupted by controlled rollout");
    }
    if (originRun.status === "running") {
      if (current.rolloutProvenance) {
        return cancel("originating Run process or descendant is still active");
      }
      return null;
    }

    if (current.capacityWait) {
      if (Date.parse(current.expiresAt) <= nowMs) {
        return null;
      }
      if (db.hasChatLock(current.chatKey)) {
        return null;
      }
      if (isClaimedCapacity) {
        if (current.outward && current.successorRunId) {
          const successor = db.getRun(current.successorRunId);
          if (!successor || successor.status === "running") return null;
          if (capacityCompletionProven(db, current)) {
            db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
              JSON.stringify({ ...current, state: "completed", completedAt: new Date(nowMs).toISOString() }), key(id));
            return null;
          }
          // A completed response is the only safe evidence of success. A
          // non-capacity failed successor must not be replayed after restart.
          if (successor.status === "cancelled") return cancel("outward ACP successor was cancelled");
          if (successor.status === "failed") return cancel("outward ACP successor failed before durable retry was confirmed; inspect before re-execution", "failed");
        }
        if (current.retainedPendingMessageIds?.length && !db.hasAnyPendingMessageId(current.surfaceIdentity, current.chatKey, current.retainedPendingMessageIds)) {
          const failure = capacitySuccessorFailure(db, current);
          const state = capacityCompletionProven(db, current) ? "completed" : failure;
          if (state) {
            db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
              .run(JSON.stringify({ ...current, state, completedAt: new Date(nowMs).toISOString(),
                ...(failure ? { error: `successor Run ${failure}` } : {}) }), key(id));
          }
          // No receipt and no terminal successor is an ambiguous outcome; never replay it.
          return null;
        }
        const claimantRunId = current.claimRunId;
        const claimExpiresAtMs = current.claimExpiresAt ? Date.parse(current.claimExpiresAt) : 0;
        if (options?.isProcessAlive && claimantRunId) {
          if (options.isProcessAlive(claimantRunId)) {
            return null;
          }
        } else if (claimExpiresAtMs > nowMs) {
          return null;
        }
      }
      if (
        originRun.status !== "failed"
        || originRun.surface_identity !== current.surfaceIdentity
        || originRun.chat_id !== current.chatKey
        || originRun.bot !== current.provider
      ) return cancel("capacity wait origin no longer matches its settled provider attempt");
      if (isPending && Date.parse(current.dueAt) > nowMs) return null;
      const claimRunId = options?.runId ?? (db as any).runId;
      const claimToken = options?.claimToken ?? randomUUID();
      const leaseMs = options?.leaseMs ?? (db as any).lockLeaseMs ?? 90_000;
      const claimExpiresAt = new Date(nowMs + leaseMs).toISOString();
      const claimed: RunContinuation = {
        ...current,
        state: "claimed",
        claimedAt: new Date(nowMs).toISOString(),
        claimRunId,
        claimToken,
        claimExpiresAt,
      };
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(claimed), key(id));
      return claimed;
    }

    // A reconciler must never write a continuation under the all-role fence.
    // Only the existing post-restart claimant can attach already completed
    // audit proof. An unverified fence or missing/ambiguous audit leaves work
    // dormant; no successor can be admitted without this exact proof.
    let rolloutProvenance = current.rolloutProvenance;
    if (!rolloutProvenance && originRun.status === "failed"
      && originRun.error === "interrupted_by_controlled_rollout") {
      const audit = provenPostRolloutAudit(db, current.originRunId);
      if (!audit) return null;
      rolloutProvenance = {
        reconciledAt: audit.completedAt,
        reason: "interrupted_by_controlled_rollout",
        reconciliationAuditId: audit.id,
        originRunId: current.originRunId,
        surfaceIdentity: current.surfaceIdentity,
        chatKey: current.chatKey,
        provider: current.provider,
      };
    }
    if (rolloutProvenance) {
      if (db.raw.prepare("SELECT 1 FROM settings WHERE key = 'agent-bridge:idle-maintenance:v1'").get()) return null;
      const prov = rolloutProvenance;

      const isProcessAlive = options?.isProcessAlive ?? ((runId: string) => getRunOwnedProcessState(runId) !== "absent");
      if (isProcessAlive(current.originRunId)) {
        return cancel("originating Run process or descendant is still active");
      }

      if (
        prov.originRunId !== current.originRunId
        || prov.surfaceIdentity !== current.surfaceIdentity
        || prov.chatKey !== current.chatKey
        || prov.provider !== current.provider
        || prov.reason !== "interrupted_by_controlled_rollout"
      ) {
        return cancel("invalid rollout provenance metadata");
      }

      if (
        originRun.status !== "failed"
        || originRun.error !== "interrupted_by_controlled_rollout"
        || originRun.surface_identity !== current.surfaceIdentity
        || originRun.chat_id !== current.chatKey
        || originRun.bot !== current.provider
      ) {
        return cancel("originating Run does not match rollout provenance");
      }

      const auditRow = db.raw.prepare(`
        SELECT id, kind, subject_id, status, reason, before_json
        FROM reconciliation_audit
        WHERE id = ?
      `).get(prov.reconciliationAuditId) as {
        id: string;
        kind: string;
        subject_id: string;
        status: string;
        reason: string;
        before_json: string;
      } | undefined;

      if (
        !auditRow
        || auditRow.kind !== "run"
        || auditRow.subject_id !== current.originRunId
        || auditRow.status !== "completed"
        || auditRow.reason !== "interrupted_by_controlled_rollout"
      ) {
        return cancel("reconciliation audit evidence missing or invalid");
      }

      try {
        const before = JSON.parse(auditRow.before_json);
        if (before.containmentState !== "proven" || before.processState !== "absent") {
          return cancel("reconciliation containment not proven");
        }
      } catch {
        return cancel("reconciliation audit payload malformed");
      }

      if (db.hasChatLock(current.chatKey) || db.hasRunLock(originRun.run_id)) {
        return null;
      }

      const claimedCount = (db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_messages
        WHERE chat_key = ? AND surface = ? AND (state = 'claimed' OR claim_run_id IS NOT NULL)
      `).get(current.chatKey, current.surfaceIdentity) as { count: number }).count;
      if (claimedCount > 0) return null;

      const abortCount = (db.raw.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_messages
        WHERE chat_key = ? AND surface = ? AND prompt IN ('/stop', '/cancel', '/reset')
      `).get(current.chatKey, current.surfaceIdentity) as { count: number }).count;
      if (abortCount > 0) {
        return cancel("originating Run cancelled or reset by user");
      }

      // Existing agent-requested Workstream wakes stay unchanged on an aborted
      // rollout. Only after an audited interruption do they become eligible
      // inspection-first recovery candidates, preserving their original due
      // time and the same unique continuation record.
      const originalId = !current.rolloutRecoveryOnly && current.outwardSessionId
        && current.surfaceIdentity === "acp:outward"
        ? originalAcceptedTurnId(db, originRun, current) : null;
      const eligible = current.rolloutRecoveryOnly || originalId !== null;
      const recoveryWake: RunContinuation = originalId === null ? current
        : { ...current, rolloutRecoveryOnly: true, recoveryOriginalTurnId: originalId };
      if (current.outwardSessionId && !eligible) {
        return cancel("interrupted Workstream objective could not be attributed to one accepted user turn", "failed");
      }
      if (recoveryWake.rolloutRecoveryOnly && db.raw.prepare(
        "SELECT 1 FROM settings WHERE key IN (?, ?) LIMIT 1",
      ).get(`outward-stop-fence:${recoveryWake.chatKey}`, `outward-cancel:${recoveryWake.originRunId}`)) {
        return cancel("originating Workstream was stopped by the user");
      }
      if (recoveryWake.rolloutRecoveryOnly && !acceptedRecoveryTurn(db, recoveryWake)) {
        return cancel("accepted originating Workstream objective or authority changed", "failed");
      }
      if (Date.parse(current.dueAt) > nowMs) return null;

      const claimed: RunContinuation = {
        ...recoveryWake, rolloutProvenance, state: "claimed", claimedAt: new Date(nowMs).toISOString(),
        ...(current.outwardSessionId ? {
          claimRunId: options?.runId ?? (db as any).runId,
          claimToken: options?.claimToken ?? randomUUID(),
          claimExpiresAt: new Date(nowMs + (options?.leaseMs ?? (db as any).lockLeaseMs ?? 90_000)).toISOString(),
        } : {}),
      };
      db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(claimed), key(id));
      return claimed;
    }

    const boundSessionId = lookupProviderSession(db, { surfaceIdentity: current.surfaceIdentity, chatKey: current.chatKey }, current.provider);
    if (
      originRun.status !== "done"
      || originRun.surface_identity !== current.surfaceIdentity
      || originRun.chat_id !== current.chatKey
      || originRun.bot !== current.provider
      || !originRun.session_id
      || !ordinaryWakeBindingAuthorised(db, current, originRun.session_id, boundSessionId)
    ) {
      return cancel(
        originRun.status !== "done"
          ? `originating Run ended with status ${originRun.status}`
          : originRun.surface_identity !== current.surfaceIdentity
            ? "originating Run surface changed"
            : originRun.chat_id !== current.chatKey
              ? "originating Run conversation changed"
              : originRun.bot !== current.provider
                ? "originating Run provider changed"
                : !originRun.session_id
                  ? "originating Run has no resumable provider session"
                  : "originating provider session binding changed",
      );
    }
    if (Date.parse(current.dueAt) > nowMs) return null;
    const claimed = {
      ...current, state: "claimed" as const, claimedAt: new Date(nowMs).toISOString(),
      // ACP wakes must prove exact runner claim before the provider boundary.
      ...(current.outwardSessionId ? {
        claimRunId: options?.runId ?? (db as any).runId,
        claimToken: options?.claimToken ?? randomUUID(),
        claimExpiresAt: new Date(nowMs + (options?.leaseMs ?? (db as any).lockLeaseMs ?? 90_000)).toISOString(),
      } : {}),
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(claimed), key(id));
    return claimed;
  });
}

export function cancelPendingRunContinuation(
  db: BridgeDb,
  id: string,
  reason: string,
  nowMs = Date.now(),
): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || (current.state !== "pending" && current.state !== "claimed")) return false;
    const cancelled: RunContinuation = {
      ...current,
      state: "cancelled",
      completedAt: new Date(nowMs).toISOString(),
      error: reason.slice(0, 500),
    };
    if (current.outwardSessionId && !current.capacityWait) retireAcceptedObjectiveLink(db, current);
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(cancelled), key(id));
    return true;
  });
}

export function cancelPendingRunContinuationsForChat(
  db: BridgeDb,
  surfaceIdentity: string,
  chatKey: string,
  reason: string,
  nowMs = Date.now(),
): number {
  return db.runInTransaction(() => {
    const continuations = listRunContinuations(db, surfaceIdentity).filter(
      (c) => c.chatKey === chatKey && (c.state === "pending" || c.state === "claimed"),
    );
    let count = 0;
    for (const c of continuations) {
      if (cancelPendingRunContinuation(db, c.id, reason, nowMs)) {
        count++;
      }
    }
    return count;
  });
}

export function settleRunContinuation(
  db: BridgeDb,
  id: string,
  outcome: "completed" | "failed" | "expired" | "cancelled",
  error?: string,
  nowMs = Date.now(),
  claimantToken?: string,
): void {
  db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || (current.state !== "pending" && current.state !== "claimed")) return;
    if (current.capacityWait && outcome === "completed" && !capacityCompletionProven(db, current)) return;
    if (outcome !== "expired"
      && current.state !== "claimed"
      && !(current.capacityWait && outcome === "completed" && current.state === "pending")) return;
    // Capacity callbacks must prove the exact acquisition, rather than the
    // long-lived service process that happened to perform it.
    if ((current.capacityWait || current.outwardSessionId) && current.state === "claimed") {
      if (!claimantToken || current.claimToken !== claimantToken) return;
    } else if (claimantToken && current.claimToken && current.claimToken !== claimantToken) return;
    const settled: RunContinuation = {
      ...current,
      state: outcome,
      completedAt: new Date(nowMs).toISOString(),
      ...(outcome === "failed" && error ? { error: error.slice(0, 500) } : {}),
    };
    if (current.outwardSessionId && !current.capacityWait) retireAcceptedObjectiveLink(db, current);
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(settled), key(id));
  });
}

export function linkRunContinuationRun(db: BridgeDb, id: string, runId: string, claimantToken?: string, authorisedProvider?: RouteableBotKind, lane?: ExecutionLaneHandle): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current || current.capacityWait) return false;
    if (current.outwardSessionId) {
      if (!lane || lane.surface !== current.surfaceIdentity || lane.chatKey !== current.chatKey || !db.ownsLock(lane)) return false;
      const successor = db.getRun(runId);
      if (authorisedProvider && authorisedProvider !== current.provider) {
        const preference = db.raw.prepare("SELECT interactive_cli_preference AS pref FROM bridge_state WHERE surface_identity = ? AND chat_id = ?")
          .get(current.surfaceIdentity, current.chatKey) as { pref: string | null } | undefined;
        if (current.rolloutRecoveryOnly || current.selectionRevision === undefined ||
            outwardSelectionRevision(db, current.chatKey) <= current.selectionRevision ||
            preference?.pref !== authorisedProvider || !acceptedContinuationObjective(db, current)) return false;
      }
      if (current.state !== "claimed" || !claimantToken || current.claimToken !== claimantToken ||
          (current.successorRunId && current.successorRunId !== runId) ||
          !successor || successor.surface_identity !== current.surfaceIdentity ||
          successor.chat_id !== current.chatKey || successor.bot !== (authorisedProvider ?? current.provider)) return false;
    }
    if (current.successorRunId === runId) return true;
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...current, successorRunId: runId }), key(id));
    return true;
  });
}

/** Link a capacity wake only while its exact runner claim still owns the task. */
export function linkCapacityContinuationRun(db: BridgeDb, id: string, claimToken: string, runId: string): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    const run = db.getRun(runId);
    if (!current?.capacityWait || current.state !== "claimed" || current.claimToken !== claimToken ||
        !run || run.surface_identity !== current.surfaceIdentity || run.chat_id !== current.chatKey) return false;
    if (current.successorRunId && current.successorRunId !== runId) {
      const previous = db.getRun(current.successorRunId);
      if (!previous || previous.status !== "failed") return false;
    }
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
      .run(JSON.stringify({ ...current, successorRunId: runId }), key(id));
    return true;
  });
}

/** Reconcile only ordinary handoffs. Capacity waits retain their original receipt. */
export function reconcileRunContinuations(db: BridgeDb, surfaceIdentity: string, nowMs = Date.now()): void {
  for (const continuation of listRunContinuations(db, surfaceIdentity)) {
    if (continuation.capacityWait || continuation.state !== "claimed") continue;
    // A live outward worker may hold its claim before atomic successor admission.
    if (continuation.outwardSessionId && !continuation.successorRunId &&
        continuation.claimExpiresAt && Date.parse(continuation.claimExpiresAt) > nowMs) continue;
    const correlationKey = `${PREFIX}${continuation.id}`;
    if (db.hasPendingMessageForCorrelationKey(continuation.surfaceIdentity, correlationKey)) continue;
    if (continuation.successorRunId) {
      const run = db.getRun(continuation.successorRunId);
      if (run) {
        if (run.status === "done") {
          if (continuation.outwardSessionId && !run.outcome_status) {
            // ACP end_turn proves only the technical exchange ended. A
            // missing objective disposition must never be reported as done.
            settleRunContinuation(db, continuation.id, "failed", "successor objective outcome unresolved", nowMs, continuation.claimToken);
          } else settleRunContinuation(db, continuation.id, "completed", undefined, nowMs, continuation.claimToken);
        }
        else if (run.status === "failed" || run.status === "cancelled") {
          settleRunContinuation(db, continuation.id, run.status === "cancelled" ? "cancelled" : "failed", run.error ?? `run ${run.status}`, nowMs, continuation.claimToken);
        }
        continue;
      }
    }
    if (continuation.outwardSessionId && !continuation.successorRunId &&
        continuation.claimExpiresAt && Date.parse(continuation.claimExpiresAt) <= nowMs) {
      // The existing atomic successor link is committed before any provider
      // execution. No successor + no queued occurrence proves this wake never
      // reached the provider boundary. Rotate its claim by requeueing; a
      // concurrent stale worker must revalidate its exact token before admission.
      db.runInTransaction(() => {
        const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?")
          .get(key(continuation.id)) as { value: string } | undefined;
        const current = row ? parse(row.value) : null;
        if (!current || current.state !== "claimed" || !current.outwardSessionId ||
            current.claimToken !== continuation.claimToken || current.successorRunId ||
            db.hasPendingMessageForCorrelationKey(current.surfaceIdentity, `${PREFIX}${current.id}`)) return;
        db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify({
          ...current, state: "pending", claimedAt: undefined, claimRunId: undefined,
          claimToken: undefined, claimExpiresAt: undefined,
        }), key(current.id));
      });
      continue;
    }
    settleRunContinuation(db, continuation.id, "failed", "interrupted_by_restart", nowMs, continuation.claimToken);
  }
}

/** A wake that did not obtain the retained queue work remains retryable. */
export function requeueClaimedCapacityWait(
  db: BridgeDb,
  id: string,
  nowMs: number,
  claimantToken?: string,
): void {
  db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current?.capacityWait || current.state !== "claimed") return;
    if (!claimantToken || current.claimToken !== claimantToken) return;
    if (Date.parse(current.expiresAt) <= nowMs) {
      // Leave expiry finalisation to the expiry path so it can retire the
      // original receipt and deliver its durable final notification.
      return;
    }
    const ids = current.retainedPendingMessageIds ?? [];
    // A thrown wake is retryable only after the durable receipt is known to be
    // queued again.  Any active or ambiguous owner keeps the wait claimed.
    if ((ids.length > 0 && (!db.hasAnyPendingMessageId(current.surfaceIdentity, current.chatKey, ids)
      || db.isAnyPendingMessageClaimed(current.surfaceIdentity, current.chatKey, ids)))
      || db.hasChatLock(current.chatKey)) return;
    const dueAt = new Date(Math.min(Date.parse(current.expiresAt), nowMs + 300_000)).toISOString();
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run(JSON.stringify({ ...current, state: "pending", dueAt, claimedAt: undefined, claimRunId: undefined, claimToken: undefined, claimExpiresAt: undefined }), key(id));
  });
}

/** The worker has positively classified this *specific* successor as a
 * pre-submission capacity rejection. Clear only that failed successor link
 * under its exact claim, permitting a bounded repeat without blind replay. */
export function requeueProvenOutwardCapacityRejection(
  db: BridgeDb,
  id: string,
  claimantToken: string,
  nowMs = Date.now(),
): boolean {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(id)) as { value: string } | undefined;
    const current = row ? parse(row.value) : null;
    if (!current?.outward || current.state !== "claimed" || current.claimToken !== claimantToken
        || !current.successorRunId || db.hasChatLock(current.chatKey)
        || Date.parse(current.expiresAt) <= nowMs) return false;
    const successor = db.getRun(current.successorRunId);
    if (!successor || successor.status !== "failed"
        || successor.surface_identity !== current.surfaceIdentity || successor.chat_id !== current.chatKey) return false;
    const dueAt = new Date(Math.min(Date.parse(current.expiresAt), nowMs + 300_000)).toISOString();
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify({
      ...current, state: "pending", dueAt, successorRunId: undefined,
      claimedAt: undefined, claimRunId: undefined, claimToken: undefined, claimExpiresAt: undefined,
    }), key(id));
    return true;
  });
}

export async function scanRunContinuations(
  db: BridgeDb,
  surfaceIdentity: string,
  dispatch: (continuation: RunContinuation) => Promise<ContinuationDispatchOutcome>,
  nowMs = Date.now(),
  options?: ClaimRunContinuationOptions & { onCapacityExpired?: (continuation: RunContinuation) => Promise<void> | void },
): Promise<void> {
  reconcileRunContinuations(db, surfaceIdentity, nowMs);
  for (const candidate of listRunContinuations(db, surfaceIdentity)) {
    if (candidate.state !== "pending" && !(candidate.state === "claimed" && candidate.capacityWait)) continue;
    if (candidate.capacityWait && Date.parse(candidate.expiresAt) <= nowMs) {
// Candidate state is pending or claimed capacity wait
      const ids = candidate.retainedPendingMessageIds ?? [];
      if (!candidate.expiryDeliveryPending) {
        if ((ids.length > 0 && !db.hasAnyPendingMessageId(candidate.surfaceIdentity, candidate.chatKey, ids)) || (candidate.outward && candidate.successorRunId)) {
          const failure = capacitySuccessorFailure(db, candidate);
          if (capacityCompletionProven(db, candidate)) settleRunContinuation(db, candidate.id, "completed", undefined, nowMs, candidate.claimToken);
          else if (failure) settleRunContinuation(db, candidate.id, failure, `successor Run ${failure}`, nowMs, candidate.claimToken);
          // A lost receipt without terminal evidence is ambiguous, even at expiry.
          continue;
        }
        if (db.hasChatLock(candidate.chatKey) || (ids.length > 0 && db.isAnyPendingMessageClaimed(candidate.surfaceIdentity, candidate.chatKey, ids))) {
          continue;
        }
      }

      const runnerRunId = options?.runId ?? (db as any).runId ?? "continuation-runner";
      const claimToken = options?.claimToken ?? randomUUID();
      const leaseMs = options?.leaseMs ?? (db as any).lockLeaseMs ?? 90_000;
      const claimExpiresAt = new Date(nowMs + leaseMs).toISOString();

      const claimedExpiry = db.runInTransaction((): RunContinuation | null => {
        const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key(candidate.id)) as { value: string } | undefined;
        const current = row ? parse(row.value) : null;
        // Revalidate the current state, not the stale scan candidate: a
        // concurrently failed continuation must not be revived for expiry.
        if (!current?.capacityWait || (current.state !== "pending" && current.state !== "claimed")) return null;

        if (current.expiryDeliveryPending) {
          const claimExpiresAtMs = current.claimExpiresAt ? Date.parse(current.claimExpiresAt) : 0;
          const claimantAlive = current.claimRunId && options?.isProcessAlive?.(current.claimRunId);
          // A verified live claimant may still be inside an external delivery
          // call after its lease. Do not duplicate that delivery; only a
          // known-dead claimant or an unknown claimant past its lease yields.
          if (claimantAlive === true || (claimExpiresAtMs > nowMs && claimantAlive !== false)) return null;
        }

        if (ids.length > 0 && !current.expiryDeliveryPending) {
          if (db.hasChatLock(current.chatKey)
            || db.isAnyPendingMessageClaimed(current.surfaceIdentity, current.chatKey, ids)
            || !db.retireQueuedPendingMsgs(current.surfaceIdentity, current.chatKey, ids)) return null;
        }

        const updated: RunContinuation = {
          ...current,
          state: "claimed",
          expiryDeliveryPending: true,
          claimRunId: runnerRunId,
          claimToken,
          claimExpiresAt,
          claimedAt: current.claimedAt ?? new Date(nowMs).toISOString(),
        };
        db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(updated), key(candidate.id));
        return updated;
      });

      if (!claimedExpiry) continue;

      await options?.onCapacityExpired?.(claimedExpiry);
      settleRunContinuation(db, claimedExpiry.id, "expired", undefined, nowMs, claimedExpiry.claimToken);
      continue;
    }
    const claimed = claimDueRunContinuation(db, candidate.id, nowMs, options);
    if (!claimed) continue;
    try {
      const outcome = await dispatch(claimed);
      if (claimed.capacityWait) {
        const current = listRunContinuations(db, surfaceIdentity).find((item) => item.id === claimed.id);
        if (!current || current.state !== "claimed" || current.claimToken !== claimed.claimToken) continue;
        // A worker that has positively classified this attempt as a
        // pre-submission capacity rejection requests a safe bounded retry.
        // All other failures require authoritative terminal evidence.
        if (current.outward && outcome === false) {
          requeueProvenOutwardCapacityRejection(db, claimed.id, claimed.claimToken!, nowMs);
          continue;
        }
        const failure = capacitySuccessorFailure(db, current);
        if (failure) {
          settleRunContinuation(db, current.id, failure, `successor Run ${failure}`, nowMs, claimed.claimToken);
          continue;
        }
        if (!capacityCompletionProven(db, current) || outcome === false || outcome === "queued") {
          requeueClaimedCapacityWait(db, claimed.id, nowMs, claimed.claimToken);
          continue;
        }
      }
      if (outcome === "failed" || outcome === "fenced") {
        throw new Error(`continuation dispatch did not settle: ${outcome}`);
      }
      if (outcome === "queued") {
        continue;
      }
      settleRunContinuation(db, claimed.id, "completed", undefined, nowMs, claimed.claimToken);
    } catch (error) {
      if (claimed.outward || claimed.outwardSessionId) {
        // Never retry a thrown/ambiguous provider outcome just because the
        // continuation callback failed. Preserve the task for inspection.
        settleRunContinuation(db, claimed.id, "failed", error instanceof Error ? error.message : "outward ACP resume failed", nowMs, claimed.claimToken);
        continue;
      }
      if (claimed.capacityWait) {
        requeueClaimedCapacityWait(db, claimed.id, nowMs, claimed.claimToken);
        continue;
      }
      settleRunContinuation(db, claimed.id, "failed", error instanceof Error ? error.message : String(error), nowMs, claimed.claimToken);
      throw error;
    }
  }
}

export class RunContinuationRunner {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly db: BridgeDb,
    private readonly surfaceIdentity: string,
    private readonly dispatch: (continuation: RunContinuation) => Promise<ContinuationDispatchOutcome>,
    private readonly scanMs = DEFAULT_SCAN_MS,
    private readonly options?: ClaimRunContinuationOptions & { onCapacityExpired?: (continuation: RunContinuation) => Promise<void> | void },
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.scanning) return;
      this.scanning = true;
      void scanRunContinuations(this.db, this.surfaceIdentity, this.dispatch, Date.now(), this.options)
        .catch((error) => console.error("[run-continuation] scan failed", error))
        .finally(() => { this.scanning = false; });
    };
    tick();
    this.timer = setInterval(tick, this.scanMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export function buildPostRolloutVerificationTurnText(reason: string): string {
  return [
    "[Agent Bridge post-rollout verification]",
    "The previous service was restarted by a controlled rollout.",
    "Perform bounded read-only verification of current service health and external state for the requested check.",
    "Do not repeat completed side effects, apply mutations, or replay previous operations.",
    `Verification reason: ${reason}`,
  ].join("\n");
}

/** Shared instruction for unfinished objectives; never replay the original user request. */
export function buildRunContinuationInstruction(continuation: RunContinuation): string {
  if (continuation.rolloutRecoveryOnly) {
    return [
      "[Agent Bridge continuation]",
      "A previously accepted Workstream objective has no verified final outcome.",
      "Before acting, inspect the conversation, current files and commits, queued work, durable receipts and any external operations.",
      "Determine what has actually completed. Do not replay the previous mutating request or duplicate external side effects.",
      "Continue only the outstanding authorised work. Report normal meaningful progress, a verified result or a genuine blocker.",
      "Do not announce or explain an infrastructure change unless it is itself relevant to a genuine blocker.",
    ].join("\n");
  }
  return [
    "[Agent Bridge continuation]",
    "A required bounded operation was still pending in the previous Run.",
    "Re-check current external state and continue the original objective from where you left off.",
    "Do not repeat completed side effects. If the operation is still pending and keeping this Run open is impractical, request another bounded continuation.",
    "Work quietly: scratchpad and clock checks, polling, retries, and continuation scheduling are internal activity, not user progress updates.",
    "Only report meaningful new results or blockers in concise user-facing language; do not repeat unchanged status or expose internal identifiers or timestamps unless needed.",
    `Pending reason: ${continuation.reason}`,
  ].join("\n");
}

/** Surfaces with native thread coordinates (Telegram topics, Slack threads) share this builder. */
export function buildTelegramRunContinuationTurn(
  continuation: RunContinuation,
  actorId: string,
): InteractiveTurnInput {
  // Delivery coordinates are persisted at request time (or recovered once, by
  // parse(), from a legacy pre-delivery record) -- this builder must never
  // parse them back out of chatKey itself.
  const delivery = continuation.delivery ?? parse(JSON.stringify(continuation))?.delivery;
  if (!delivery) throw new Error("run continuation has no Telegram delivery coordinates");
  const isRollout = Boolean(continuation.rolloutProvenance);
  return {
    surfaceIdentity: continuation.surfaceIdentity,
    chatKey: continuation.chatKey,
    actorId,
    messageId: `continuation:${continuation.id}`,
    scheduledOccurrenceKey: `${PREFIX}${continuation.id}`,
    text: isRollout
      ? buildPostRolloutVerificationTurnText(continuation.reason)
      : buildRunContinuationInstruction(continuation),
    ...(delivery.threadId === undefined ? {} : { threadId: String(delivery.threadId) }),
    delivery,
    queueOnly: true,
    attachments: [],
    executionMode: isRollout ? "safe" : undefined,
    verificationOnly: isRollout ? true : undefined,
  };
}

export function buildDiscordRunContinuationTurn(
  continuation: RunContinuation,
  actorId: string,
): InteractiveTurnInput {
  const delivery = continuation.delivery ?? parse(JSON.stringify(continuation))?.delivery;
  if (!delivery) throw new Error("run continuation has no Discord delivery coordinates");
  const isRollout = Boolean(continuation.rolloutProvenance);
  return {
    surfaceIdentity: continuation.surfaceIdentity,
    chatKey: continuation.chatKey,
    actorId,
    messageId: `continuation:${continuation.id}`,
    scheduledOccurrenceKey: `${PREFIX}${continuation.id}`,
    text: isRollout
      ? buildPostRolloutVerificationTurnText(continuation.reason)
      : buildRunContinuationInstruction(continuation),
    delivery,
    surroundingContext: [],
    queueOnly: true,
    attachments: [],
    executionMode: isRollout ? "safe" : undefined,
    verificationOnly: isRollout ? true : undefined,
  };
}

// Reuse the same persisted-record validity contract at upgrade admission.
export { parse as parseRunContinuation };
