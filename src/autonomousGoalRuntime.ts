import { randomUUID } from "node:crypto";
import type { BridgeDb, ExecutionLaneHandle } from "./db.js";
import { openDb } from "./db.js";
import { BridgeEngine, type SurfaceNeutralTurnInput } from "./engine.js";
import { EventStore } from "./events/store.js";
import type { BotKind } from "./types.js";

export const AUTONOMOUS_EVENT_SOURCE = "autonomous" as const;
export const AUTONOMOUS_EVENT_KIND = "goal_wake" as const;
export const AUTONOMOUS_RUN_SURFACE = "autonomous" as const;
export const AUTONOMOUS_RUN_AUTHORITY_SCOPE = "goal-constraints-only" as const;
export const AUTONOMOUS_RUN_CHAT_KEY_PREFIX = "autonomous:";
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_REASON_CHARS = 300;

export type AutonomousGoalStatus = "active" | "complete" | "blocked" | "cancelled" | "budget_exhausted";
export type AutonomousCycleStatus = "progress" | "complete" | "blocked" | "cancelled";

export interface AutonomousGoal {
  goalId: string;
  prompt: string;
  constraints: string[];
  bot: BotKind;
  maxCycles: number;
  cycle: number;
  status: AutonomousGoalStatus;
  evidence: string[];
}

export interface AutonomousCycleResult {
  status: AutonomousCycleStatus;
  evidence: string;
  nextWakeReason?: string;
}

export class AutonomousGoalLaneUnavailableError extends Error {
  constructor(goalId: string) {
    super(`execution lane ${AUTONOMOUS_RUN_SURFACE}:${AUTONOMOUS_RUN_CHAT_KEY_PREFIX}${goalId} is already held`);
    this.name = "AutonomousGoalLaneUnavailableError";
  }
}

function goalChatKey(goalId: string): string {
  return `${AUTONOMOUS_RUN_CHAT_KEY_PREFIX}${goalId}`;
}

function rowToGoal(row: any): AutonomousGoal {
  return {
    goalId: row.goal_id,
    prompt: row.prompt,
    constraints: JSON.parse(row.constraints_json),
    bot: row.bot,
    maxCycles: row.max_cycles,
    cycle: row.cycle,
    status: row.status,
    evidence: JSON.parse(row.evidence_json),
  };
}

export function getAutonomousGoal(db: BridgeDb, goalId: string): AutonomousGoal {
  const row = db.raw.prepare("SELECT * FROM autonomous_goals WHERE goal_id = ?").get(goalId);
  if (!row) throw new Error(`autonomous goal ${goalId} not found`);
  return rowToGoal(row);
}

function scheduleWake(db: BridgeDb, goalId: string, input: { key: string; reason: string }): boolean {
  const existing = db.getEventReceiptByIdempotencyKey(input.key);
  if (existing) return false;
  db.createEventReceipt({
    event_id: input.key,
    source: AUTONOMOUS_EVENT_SOURCE,
    event_kind: AUTONOMOUS_EVENT_KIND,
    idempotency_key: input.key,
    received_at: new Date().toISOString(),
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify({ goalId, reason: input.reason.slice(0, MAX_REASON_CHARS) }),
    authority_scope: AUTONOMOUS_RUN_AUTHORITY_SCOPE,
  });
  return true;
}

export class SqliteAutonomousGoalStore {
  constructor(private readonly db: BridgeDb) {}

  scheduleWake(goalId: string, input: { key: string; reason: string }): boolean {
    return scheduleWake(this.db, goalId, input);
  }
}

export function createAutonomousGoal(db: BridgeDb, input: {
  goalId: string;
  prompt: string;
  constraints: string[];
  bot: BotKind;
  maxCycles: number;
}): AutonomousGoal {
  if (!input.goalId || !input.prompt || !Number.isInteger(input.maxCycles) || input.maxCycles < 1) {
    throw new Error("goalId, prompt, and a positive integer maxCycles are required");
  }
  db.runInTransaction(() => {
    db.raw.prepare(`INSERT INTO autonomous_goals
      (goal_id, prompt, constraints_json, bot, max_cycles) VALUES (?, ?, ?, ?, ?)`)
      .run(input.goalId, input.prompt, JSON.stringify(input.constraints), input.bot, input.maxCycles);
    scheduleWake(db, input.goalId, { key: `${input.goalId}:wake:0`, reason: "initial" });
  });
  return getAutonomousGoal(db, input.goalId);
}

function parseEnvelope(text: string): string {
  try {
    const outer = JSON.parse(text) as any;
    if (outer && outer.type === "result" && typeof outer.result === "string") return outer.result;
  } catch {
    // Some injected seams return the provider text directly.
  }
  return text;
}

export function parseAutonomousCycleResult(text: string): AutonomousCycleResult {
  let parsed: unknown;
  try { parsed = JSON.parse(parseEnvelope(text)); } catch { throw new Error("malformed autonomous cycle result"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed autonomous cycle result");
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["evidence", "nextWakeReason", "status"].includes(key))) throw new Error("unknown autonomous cycle result field");
  if (!["progress", "complete", "blocked", "cancelled"].includes(value.status as string)) throw new Error("invalid autonomous cycle status");
  if (typeof value.evidence !== "string" || value.evidence.length > MAX_EVIDENCE_CHARS) throw new Error("invalid autonomous cycle evidence");
  if (value.nextWakeReason !== undefined && (typeof value.nextWakeReason !== "string" || value.nextWakeReason.length > MAX_REASON_CHARS)) throw new Error("invalid autonomous wake reason");
  if (value.status === "progress" && typeof value.nextWakeReason !== "string") throw new Error("progress requires nextWakeReason");
  return { status: value.status as AutonomousCycleStatus, evidence: value.evidence, nextWakeReason: value.nextWakeReason as string | undefined };
}

function buildPrompt(goal: AutonomousGoal, cycle: number, priorEvidence: string[], wakeReason: string): string {
  return [
    "You are the provider executive for one bounded autonomous cycle.",
    `Original goal: ${goal.prompt}`,
    `Constraints/authority: ${goal.constraints.join("; ") || "none"}. Do not expand this authority.`,
    `Current cycle: ${cycle}`,
    `Prior evidence: ${priorEvidence.length ? priorEvidence.join(" | ") : "none"}`,
    `Wake reason: ${wakeReason}`,
    'Return JSON only with exactly: {"status":"progress|complete|blocked|cancelled","evidence":"bounded evidence","nextWakeReason":"reason"}.',
    'The status must be exactly one of "progress", "complete", "blocked", or "cancelled"; omit nextWakeReason for terminal results.',
  ].join("\n");
}

function claimWakeAndRun(db: BridgeDb, goalId: string, receiptId: number): string | null {
  const runId = randomUUID();
  const chatKey = goalChatKey(goalId);
  const claimed = db.raw.transaction(() => {
    const receipt = db.raw.prepare("SELECT status FROM event_receipts WHERE id = ? AND source = 'autonomous'").get(receiptId) as { status: string } | undefined;
    if (!receipt || receipt.status !== "received") return false;
    db.insertRun(runId, chatKey, getAutonomousGoal(db, goalId).bot);
    const result = db.raw.prepare("UPDATE event_receipts SET status = 'run_created', run_id = ? WHERE id = ? AND status = 'received'").run(runId, receiptId);
    if (result.changes !== 1) throw new Error("autonomous wake claim lost");
    return true;
  })();
  return claimed ? runId : null;
}

function pendingWake(db: BridgeDb, goalId: string): any | null {
  return db.raw.prepare(`SELECT * FROM event_receipts
    WHERE source = 'autonomous' AND status = 'received'
      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1`).get(goalId) ?? null;
}

function reconcile(db: BridgeDb, goal: AutonomousGoal, receipt: any, runId: string, result: AutonomousCycleResult | null, error?: string): void {
  db.runInTransaction(() => {
    const run = db.getRun(runId);
    const evidence = result?.evidence ?? error ?? "malformed provider output";
    const nextEvidence = [...goal.evidence, evidence].slice(-20);
    if (run?.status === "cancelled") {
      db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = 'cancelled', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?").run(goal.cycle + 1, JSON.stringify(nextEvidence), goal.goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      return;
    }
    if (!result) {
      db.raw.prepare("UPDATE bridge_runs SET status = 'failed', ended_at = CURRENT_TIMESTAMP, error = ? WHERE run_id = ? AND status IN ('running', 'done')")
        .run(error ?? "malformed autonomous cycle result", runId);
      db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = 'blocked', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?").run(goal.cycle + 1, JSON.stringify(nextEvidence), goal.goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'failed', error_class = ?, result_reference = ? WHERE id = ? AND status = 'run_created'").run("malformed_result", runId, receipt.id);
      return;
    }
    db.updateRunCompleted(runId, result.evidence, null);
    db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
    const nextStatus: AutonomousGoalStatus = result.status === "progress"
      ? (goal.cycle + 1 >= goal.maxCycles ? "budget_exhausted" : "active")
      : result.status;
    db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?")
      .run(goal.cycle + 1, nextStatus, JSON.stringify(nextEvidence), goal.goalId);
    if (result.status === "progress" && nextStatus === "active") {
      scheduleWake(db, goal.goalId, { key: `${goal.goalId}:wake:${goal.cycle + 1}`, reason: result.nextWakeReason! });
    }
  });
}

export async function runNextAutonomousGoal(db: BridgeDb, goalId: string, engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">): Promise<void> {
  const goal = getAutonomousGoal(db, goalId);
  if (goal.status !== "active") return;
  const wake = pendingWake(db, goalId);
  if (!wake) return;
  const laneHandle: ExecutionLaneHandle | null = db.acquireLock(AUTONOMOUS_RUN_SURFACE, goalChatKey(goalId));
  if (!laneHandle) throw new AutonomousGoalLaneUnavailableError(goalId);
  try {
    const current = getAutonomousGoal(db, goalId);
    const currentWake = pendingWake(db, goalId);
    if (current.status !== "active" || !currentWake) return;
    const runId = claimWakeAndRun(db, goalId, currentWake.id);
    if (!runId) return;
    const eventStore = new EventStore(db, runId);
    const input: SurfaceNeutralTurnInput = {
      prompt: buildPrompt(current, current.cycle + 1, current.evidence, JSON.parse(currentWake.payload_json).reason),
      sessionId: null,
      chatId: 0,
      chatKey: goalChatKey(goalId),
      laneHandle,
      runId,
      eventContext: { runId, bot: current.bot, chatId: goalChatKey(goalId), threadId: undefined, serviceId: laneHandle.serviceId, acquisitionId: laneHandle.acquisitionId },
      collect: (event) => event.type === "run.completed" ? eventStore.queueCompleted(event) : eventStore.collect(event),
      finalize: () => eventStore.finalize(),
    };
    let parsed: AutonomousCycleResult | null = null;
    let error: string | undefined;
    try {
      const result = await engine.executeSurfaceNeutralTurn(input);
      parsed = parseAutonomousCycleResult(result.text);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      eventStore.finalize();
    }
    reconcile(db, current, currentWake, runId, parsed, error);
  } finally {
    db.unlock(laneHandle);
  }
}

export async function drainAutonomousGoal(db: BridgeDb, goalId: string, engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">): Promise<void> {
  while (getAutonomousGoal(db, goalId).status === "active") await runNextAutonomousGoal(db, goalId, engine);
}

export async function runAutonomousGoalOperator(db: BridgeDb, args: string[], engine?: Pick<BridgeEngine, "executeSurfaceNeutralTurn">): Promise<AutonomousGoal> {
  const [operation, goalId] = args;
  if (operation === "create") {
    const maxIndex = args.indexOf("--max-cycles");
    const prompt = args.slice(2, maxIndex === -1 ? args.length : maxIndex).join(" ");
    const maxCycles = Number(maxIndex === -1 ? 3 : args[maxIndex + 1]);
    return createAutonomousGoal(db, { goalId, prompt, constraints: ["operator-approved goal authority"], bot: "claude", maxCycles });
  }
  if (operation === "status") return getAutonomousGoal(db, goalId);
  if (operation === "run" && engine) {
    await drainAutonomousGoal(db, goalId, engine);
    return getAutonomousGoal(db, goalId);
  }
  throw new Error("usage: create <goal-id> <prompt> [--max-cycles N] | run <goal-id> | status <goal-id>");
}

export async function runAutonomousGoalLiveSmoke(databasePath: string): Promise<{ providerBoundaryReached: boolean; status: AutonomousGoalStatus }> {
  const db = openDb(databasePath, { serviceId: "autonomous-live-smoke", runId: randomUUID() });
  const command = process.env.AGENT_BRIDGE_AUTONOMOUS_PROVIDER_COMMAND ?? "claude";
  const client = { getUpdates: async () => ({ result: [], ok: true }), sendMessage: async () => ({ ok: true }), sendChatAction: async () => ({ ok: true }) } as any;
  const engine = new BridgeEngine({ surfaceIdentity: AUTONOMOUS_RUN_SURFACE, kind: "autonomous", executionKind: "claude", botConfig: { command, modelPreference: ["default"] }, allowedUserIds: new Set(["operator"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000 }, db, client);
  const goalId = `live-smoke-${randomUUID()}`;
  createAutonomousGoal(db, { goalId, prompt: "Return a bounded JSON result only; do not modify files or contact external systems.", constraints: ["non-destructive smoke only"], bot: "claude", maxCycles: 1 });
  await drainAutonomousGoal(db, goalId, engine);
  const status = getAutonomousGoal(db, goalId).status;
  db.close();
  return { providerBoundaryReached: true, status };
}
