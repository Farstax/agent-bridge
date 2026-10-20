import Database from "better-sqlite3";
import { BridgeDb } from "./db.js";
import { requestRunContinuation } from "./runContinuation.js";
import type { RouteableBotKind } from "./types.js";

/** Original provider turn may already have executed side effects. Never replay it merely because reconciliation failed. */
export class RunOutcomeReconciliationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RunOutcomeReconciliationError";
  }
}

export class MissingRunOutcomeError extends Error {
  constructor(message: string) { super(message); this.name = "MissingRunOutcomeError"; }
}

/** This is the sole new retry limit. Zero disables reconciliation; one is the default. */
export function missingOutcomeRetries(env: Record<string, string | undefined> = process.env): 0 | 1 {
  const raw = env.AGENT_BRIDGE_MISSING_OUTCOME_RETRIES ?? "1";
  if (raw !== "0" && raw !== "1") throw new Error("AGENT_BRIDGE_MISSING_OUTCOME_RETRIES must be 0 or 1");
  return Number(raw) as 0 | 1;
}

export type RunOutcomeStatus = "complete" | "continue" | "blocked";
export interface RunOutcome { status: RunOutcomeStatus; detail: string }
type EnvLike = Record<string, string | undefined>;

function required(env: EnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function option(args: string[], key: string): string | null {
  const index = args.indexOf(key);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
  return value;
}

/** The terminal outcome is a provider claim; ACP end_turn and CI verification remain distinct. */
export function readRunOutcome(db: BridgeDb, runId: string): RunOutcome | null {
  const row = db.getRun(runId) as { outcome_status?: RunOutcomeStatus | null; outcome_detail?: string | null } | undefined;
  if (!row?.outcome_status) return null;
  return { status: row.outcome_status, detail: row.outcome_detail ?? "" };
}

/** Atomic, fenced, single-disposition update against the actual persisted Run. */
export function recordRunOutcome(db: BridgeDb, input: {
  runId: string; surfaceIdentity: string; chatKey: string; provider: string;
  status: RunOutcomeStatus; detail: string;
  lock: { serviceId: string; runId: string; acquisitionId: string };
}): RunOutcome {
  const detail = input.detail.trim();
  if (!detail || detail.length > 500) throw new Error("outcome detail must contain 1 to 500 characters");
  return db.runInTransaction(() => {
    const run = db.getRun(input.runId);
    if (!run || run.status !== "running") throw new Error("originating Run is not active");
    if (run.surface_identity !== input.surfaceIdentity || run.chat_id !== input.chatKey || run.bot !== input.provider) {
      throw new Error("outcome does not belong to the active Run identity");
    }
    const owner = db.raw.prepare(
      "SELECT 1 FROM execution_locks WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ? AND lease_expires_at > ?",
    ).get(input.surfaceIdentity, input.chatKey, input.lock.serviceId, input.lock.runId, input.lock.acquisitionId, new Date().toISOString());
    if (!owner) throw new Error("outcome rejected: execution-lane ownership has changed or expired");
    const existing = readRunOutcome(db, input.runId);
    if (existing) {
      if (existing.status === input.status && existing.detail === detail) return existing;
      throw new Error("Run outcome already recorded");
    }
    const change = db.raw.prepare(
      "UPDATE bridge_runs SET outcome_status = ?, outcome_detail = ? WHERE run_id = ? AND status = 'running' AND outcome_status IS NULL",
    ).run(input.status, detail, input.runId);
    if (change.changes !== 1) throw new Error("Run outcome raced with cancellation or another outcome");
    return { status: input.status, detail };
  });
}

/** The owning execution lane calls this only when abandoning a failed provider attempt.
 * A successor provider attempt in the same Run must not inherit its predecessor's claim.
 * Caller must hold the Bridge execution-lock fence; it also cancels prior pending wakes.
 */
export function clearRunOutcomeForProviderRetry(db: BridgeDb, runId: string): void {
  const change = db.raw.prepare(
    "UPDATE bridge_runs SET outcome_status = NULL, outcome_detail = NULL WHERE run_id = ? AND status = 'running'",
  ).run(runId);
  if (change.changes !== 1) throw new Error("cannot clear outcome of an inactive Run");
}

/** Shared owner for the new command and the legacy wait alias. */
export function requestAgentBridgeOutcome(args: string[], env: EnvLike = process.env): string {
  const [status, ...flags] = args;
  if (status !== "complete" && status !== "continue" && status !== "blocked") {
    throw new Error("expected complete, continue or blocked");
  }
  const dbPath = required(env, "AGENT_BRIDGE_CONTEXT_DB");
  const runId = required(env, "AGENT_BRIDGE_RUN_ID");
  const surfaceIdentity = required(env, "AGENT_BRIDGE_SURFACE_IDENTITY");
  const chatKey = required(env, "AGENT_BRIDGE_CHAT_KEY");
  const provider = required(env, "AGENT_BRIDGE_PROVIDER") as RouteableBotKind;
  const lock = {
    serviceId: required(env, "AGENT_BRIDGE_LOCK_SERVICE_ID"),
    runId: required(env, "AGENT_BRIDGE_LOCK_RUN_ID"),
    acquisitionId: required(env, "AGENT_BRIDGE_LOCK_ACQUISITION_ID"),
  };
  const detail = status === "complete" ? (option(flags, "--evidence") ?? "") : (option(flags, "--reason") ?? "");
  const secondsRaw = option(flags, "--after-seconds");
  if (status === "continue" && (secondsRaw === null || !Number.isInteger(Number(secondsRaw)))) {
    throw new Error("continue requires --after-seconds INTEGER");
  }
  if (status !== "continue" && secondsRaw !== null) throw new Error("--after-seconds is only valid for continue");

  const deliveryChatId = env.AGENT_BRIDGE_DELIVERY_CHAT_ID?.trim();
  const deliveryChatType = env.AGENT_BRIDGE_DELIVERY_CHAT_TYPE?.trim();
  const deliveryThreadId = env.AGENT_BRIDGE_DELIVERY_THREAD_ID?.trim();
  const delivery = deliveryChatId && deliveryChatType
    ? { chatId: deliveryChatId, chatType: deliveryChatType, ...(deliveryThreadId ? { threadId: deliveryThreadId } : {}) }
    : undefined;

  const raw = new Database(dbPath, { fileMustExist: true });
  raw.pragma("foreign_keys = ON");
  const db = new BridgeDb(raw, { serviceId: "run-outcome-helper", runId, leaseMs: 90_000 });
  try {
    return db.runInTransaction(() => {
      // A retried identical helper invocation must not refresh the existing
      // continuation's due time/expiry or create a new scheduling decision.
      const previous = readRunOutcome(db, runId);
      recordRunOutcome(db, { runId, surfaceIdentity, chatKey, provider, status, detail, lock });
      if (previous) {
        return status === "continue"
          ? "Continuation already scheduled for this Run. Finish this Run."
          : status === "complete" ? "Run outcome already recorded: complete." : "Run outcome already recorded: blocked.";
      }
      if (status === "continue") {
        const c = requestRunContinuation(db, {
          originRunId: runId, surfaceIdentity, chatKey, provider, reason: detail,
          afterSeconds: Number(secondsRaw), delivery,
        });
        return `Continuation scheduled for ${c.dueAt}. Finish this Run without promising the user to check manually.`;
      }
      return status === "complete" ? "Run outcome recorded: complete." : "Run outcome recorded: blocked.";
    });
  } finally {
    db.close();
  }
}


/**
 * Compatibility for pre-outcome callers. New ordinary Runs have the lane
 * credentials and record an explicit continue outcome. Older/non-outcome
 * invocations keep the original wait scheduling contract with no new
 * mandatory lock variables.
 */
export function requestAgentBridgeWait(args: string[], env: EnvLike = process.env): string {
  if (["AGENT_BRIDGE_LOCK_SERVICE_ID", "AGENT_BRIDGE_LOCK_RUN_ID", "AGENT_BRIDGE_LOCK_ACQUISITION_ID"]
    .some(key => Boolean(env[key]?.trim()))) {
    return requestAgentBridgeOutcome(["continue", ...args], env);
  }
  const dbPath = required(env, "AGENT_BRIDGE_CONTEXT_DB");
  const originRunId = required(env, "AGENT_BRIDGE_RUN_ID");
  const surfaceIdentity = required(env, "AGENT_BRIDGE_SURFACE_IDENTITY");
  const chatKey = required(env, "AGENT_BRIDGE_CHAT_KEY");
  const provider = required(env, "AGENT_BRIDGE_PROVIDER") as RouteableBotKind;
  const reason = option(args, "--reason") ?? "";
  const afterRaw = option(args, "--after-seconds");
  const afterSeconds = Number(afterRaw);
  if (!Number.isInteger(afterSeconds)) throw new Error("--after-seconds requires an integer");
  const chatId = env.AGENT_BRIDGE_DELIVERY_CHAT_ID?.trim();
  const chatType = env.AGENT_BRIDGE_DELIVERY_CHAT_TYPE?.trim();
  const threadId = env.AGENT_BRIDGE_DELIVERY_THREAD_ID?.trim();
  const delivery = chatId && chatType
    ? { chatId, chatType, ...(threadId ? { threadId } : {}) }
    : undefined;
  const raw = new Database(dbPath, { fileMustExist: true });
  raw.pragma("foreign_keys = ON");
  const db = new BridgeDb(raw, { serviceId: "run-continuation-helper", runId: originRunId, leaseMs: 90_000 });
  try {
    const continuation = requestRunContinuation(db, {
      originRunId, surfaceIdentity, chatKey, provider, reason, afterSeconds, delivery,
    });
    return `Continuation scheduled for ${continuation.dueAt}. Finish this Run without promising the user to check manually.`;
  } finally {
    db.close();
  }
}
