/**
 * PURPOSE: The one deliberate authenticated ingress boundary approved by
 * issue #347/#351 — accepts a single bounded Farstax health/operations
 * scenario (a health plugin report crossing into `red` status) and starts
 * bounded work through the existing worker Run/Skills path with no
 * preceding chat turn. Not a general event bus: only this one event kind
 * is accepted, and authorization comes solely from the authenticated
 * `token`, never from event payload content.
 * NEIGHBORS: src/db.ts, src/repositories/eventReceiptRepository.ts,
 * src/handlers/opsCheck.ts, src/health/scheduler.ts
 */
import type { BridgeDb } from "../db.js";
import type { HealthReport } from "./types.js";

export const HEALTH_EVENT_SOURCE = "health" as const;
export const HEALTH_OPS_EVENT_KIND_RED = "plugin_status_red" as const;

const MAX_PAYLOAD_BYTES = 4096;
const REDACT_KEY_PATTERN = /token|secret|password|passwd|key|authorization|credential|prompt/i;
const REDACTED = "[redacted]";

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
}

export interface AcceptedHealthOpsEvent {
  receiptId: number;
  workItemId: number | null;
  workJobId: number | null;
  /** false when this call resolved to an existing receipt from a prior delivery. */
  created: boolean;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
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

/**
 * Authenticated, idempotent ingress for one bounded scenario: a health
 * plugin report crossing into `red`. Writes the receipt durably before
 * creating any Run, dedupes on idempotencyKey (duplicate delivery returns
 * the existing receipt without creating a second work_item/work_job), and
 * creates exactly one report-only `ops_check` job through the existing
 * worker Run path (work_jobs — restart-safe lease/idempotency/cancellation
 * already enforced there). Authorization comes only from `token` matching
 * the configured authority; event payload content never grants authority.
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

  const existing = db.getEventReceiptByIdempotencyKey(event.idempotencyKey);
  if (existing) {
    return {
      receiptId: existing.id,
      workItemId: existing.work_item_id,
      workJobId: existing.work_job_id,
      created: false,
    };
  }

  const payloadJson = boundedRedactedPayload(event.report);
  const now = options.now ? options.now() : new Date().toISOString();

  const receipt = db.createEventReceipt({
    event_id: event.eventId,
    source: HEALTH_EVENT_SOURCE,
    event_kind: HEALTH_OPS_EVENT_KIND_RED,
    idempotency_key: event.idempotencyKey,
    occurred_at: event.occurredAt,
    received_at: now,
    payload_json: payloadJson,
    authority_scope: "health:report-only",
  });

  const workItem = db.createWorkItem({
    kind: "ops",
    source: HEALTH_EVENT_SOURCE,
    title: `Health degraded: ${event.report.pluginName}`,
    body: event.report.summary,
    created_by: "health-ingress",
  });

  const workJob = db.createWorkJob({
    task_type: "ops_check",
    idempotency_key: `ops_check:${event.idempotencyKey}`,
    work_item_id: workItem.id,
    input_json: {
      work_item_id: workItem.id,
      receipt_id: receipt.id,
      plugin_name: event.report.pluginName,
      status: event.report.status,
      summary: event.report.summary,
    },
  });

  db.linkEventReceiptRun(receipt.id, { work_item_id: workItem.id, work_job_id: workJob.id });

  return { receiptId: receipt.id, workItemId: workItem.id, workJobId: workJob.id, created: true };
}

/**
 * Restart-safe reconciliation: reflects the receipt's status/result/error
 * from the authoritative work_job state. Safe to call repeatedly (e.g.
 * after a process restart) — it never creates or re-executes work, and the
 * underlying work_job terminal-state transitions are themselves fenced by
 * the existing cancelled-is-final guard in workQueueRepository.
 */
export function reconcileEventReceiptResult(db: BridgeDb, receiptId: number): void {
  const receipt = db.getEventReceipt(receiptId);
  if (!receipt || receipt.work_job_id == null) return;
  const job = db.getWorkJob(receipt.work_job_id);
  if (!job) return;

  if (job.status === "completed") {
    db.recordEventReceiptResult(receipt.id, {
      status: "completed",
      result_reference: `work_job:${job.id}`,
      error_class: null,
    });
  } else if (job.status === "failed") {
    db.recordEventReceiptResult(receipt.id, {
      status: "failed",
      result_reference: `work_job:${job.id}`,
      error_class: "run_failed",
    });
  } else if (job.status === "cancelled") {
    db.recordEventReceiptResult(receipt.id, {
      status: "cancelled",
      result_reference: `work_job:${job.id}`,
      error_class: "run_cancelled",
    });
  }
  // pending/leased/running/waiting_approval: still in flight, receipt stays at 'run_created'.
}
