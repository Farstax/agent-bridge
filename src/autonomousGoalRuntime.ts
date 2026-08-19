import { randomUUID } from "node:crypto";
import type { BridgeDb, ExecutionLaneHandle } from "./db.js";
import { openProductionDb } from "./db.js";
import { BridgeEngine, type SurfaceNeutralTurnInput } from "./engine.js";
import { EventStore } from "./events/store.js";
import { killRunOwnedDescendants } from "./runOwnedProcesses.js";
import { loadBotsConfig, resolveExecutionMode } from "./config.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import type { BotConfig, BotKind } from "./types.js";

export const AUTONOMOUS_EVENT_SOURCE = "autonomous" as const;
export const AUTONOMOUS_EVENT_KIND = "goal_wake" as const;
export const AUTONOMOUS_SUPERVISOR_INPUT_KIND = "supervisor_input" as const;
export const AUTONOMOUS_RUN_SURFACE = "autonomous" as const;
export const AUTONOMOUS_RUN_AUTHORITY_SCOPE = "goal-constraints-only" as const;
export const AUTONOMOUS_RUN_CHAT_KEY_PREFIX = "autonomous:";
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_TOTAL_EVIDENCE_CHARS = 8_000;
const MAX_REASON_CHARS = 300;
const MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_CHARS = 3_000;
const MAX_AUTONOMOUS_SUPERVISOR_INPUT_CHARS = 3_000;
const MAX_AUTONOMOUS_SUPERVISOR_INPUT_TOTAL_CHARS = 6_000;
const MAX_AUTONOMOUS_SUPERVISOR_INPUTS_PER_CYCLE = 8;
const MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_IDS = 32;
const MAX_AUTONOMOUS_SUPERVISOR_ROUTE_FIELD_CHARS = 256;
const AUTONOMOUS_SUPERVISOR_SETTING_PREFIX = "autonomy:supervisor:";
const MAX_HEALTH_CONSTRAINTS = 8;
const MAX_HEALTH_CONSTRAINT_CHARS = 300;
const MAX_HEALTH_CONSTRAINT_TOTAL = 2_000;
const MAX_HEALTH_CYCLES = 10;
const HEALTH_POLICY_CONSTRAINT = "autonomous-policy:external-health-observation";

export type AutonomousGoalStatus = "active" | "complete" | "blocked" | "cancelled" | "budget_exhausted";
export type AutonomousCycleStatus = "progress" | "complete" | "blocked" | "cancelled";
export type AutonomousRunPolicy = "provider" | "external-observation";

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
  /** Optional provider-authored supervisor prose. The controller transports it unchanged. */
  supervisorMessage?: string;
}

export interface AutonomousSupervisorRoute {
  surface: string;
  address: string;
  identity?: string;
  thread?: string;
}

export interface AutonomousSupervisorState {
  route: AutonomousSupervisorRoute;
  messageIds: number[];
}

export interface CreateAutonomousGoalIfNoneActiveResult {
  goal: AutonomousGoal;
  created: boolean;
}

export interface AuthoritativeHealthObservation {
  status: "healthy" | "unhealthy" | "unknown";
  evidence: string;
  correlationId: string;
  observedAt: string;
}

export interface OwnerAuthorizedHealthRecoveryRequest {
  ownerAction: "investigate";
  goalId: string;
  correlationId: string;
  objective: string;
  healthEvidence: string;
  constraints: string[];
  bot: BotKind;
  maxCycles: number;
}

export class AutonomousGoalLaneUnavailableError extends Error {
  constructor(goalId: string) {
    super(`execution lane ${AUTONOMOUS_RUN_SURFACE}:${AUTONOMOUS_RUN_CHAT_KEY_PREFIX}${goalId} is already held`);
    this.name = "AutonomousGoalLaneUnavailableError";
  }
}

export class AutonomousGoalProgressError extends Error {
  constructor(goalId: string) {
    super(`active autonomous goal ${goalId} has no pending or recoverable autonomous wake`);
    this.name = "AutonomousGoalProgressError";
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
  initialEvidence?: string[];
}): AutonomousGoal {
  if (!input.goalId || !input.prompt || !Number.isInteger(input.maxCycles) || input.maxCycles < 1) {
    throw new Error("goalId, prompt, and a positive integer maxCycles are required");
  }
  db.runInTransaction(() => {
    db.raw.prepare(`INSERT INTO autonomous_goals
      (goal_id, prompt, constraints_json, bot, max_cycles, evidence_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.goalId, input.prompt, JSON.stringify(input.constraints), input.bot, input.maxCycles, JSON.stringify((input.initialEvidence ?? []).slice(-8)));
    scheduleWake(db, input.goalId, { key: `${input.goalId}:wake:0`, reason: "initial" });
  });
  return getAutonomousGoal(db, input.goalId);
}

function supervisorSettingKey(goalId: string): string {
  return `${AUTONOMOUS_SUPERVISOR_SETTING_PREFIX}${goalId}`;
}

function boundedSupervisorRoute(route: AutonomousSupervisorRoute): AutonomousSupervisorRoute {
  const boundedField = (name: string, value: string | undefined, required = false): string | undefined => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > MAX_AUTONOMOUS_SUPERVISOR_ROUTE_FIELD_CHARS) {
      throw new Error(`invalid autonomous supervisor ${name}`);
    }
    return value;
  };
  return {
    surface: boundedField("surface", route.surface, true)!,
    address: boundedField("address", route.address, true)!,
    ...(route.identity === undefined ? {} : { identity: boundedField("identity", route.identity)! }),
    ...(route.thread === undefined ? {} : { thread: boundedField("thread", route.thread)! }),
  };
}

function parseSupervisorState(raw: string | null): AutonomousSupervisorState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as AutonomousSupervisorState;
    if (!value || typeof value !== "object" || !Array.isArray(value.messageIds)) return null;
    return {
      route: boundedSupervisorRoute(value.route),
      messageIds: value.messageIds.filter((id) => Number.isSafeInteger(id) && id > 0).slice(-MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_IDS),
    };
  } catch {
    return null;
  }
}

export function getAutonomousSupervisorState(db: BridgeDb, goalId: string): AutonomousSupervisorState | null {
  return parseSupervisorState(db.getSetting(supervisorSettingKey(goalId)));
}

export function recordAutonomousSupervisorMessageId(db: BridgeDb, goalId: string, messageId: number): void {
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("invalid autonomous supervisor message id");
  db.runInTransaction(() => {
    const state = getAutonomousSupervisorState(db, goalId);
    if (!state) return;
    const messageIds = [...state.messageIds.filter((id) => id !== messageId), messageId].slice(-MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_IDS);
    db.setSetting(supervisorSettingKey(goalId), JSON.stringify({ ...state, messageIds }));
  });
}

export function createAutonomousGoalIfNoneActive(db: BridgeDb, input: {
  goalId: string;
  prompt: string;
  constraints: string[];
  bot: BotKind;
  maxCycles: number;
  initialEvidence?: string[];
  supervisorRoute?: AutonomousSupervisorRoute;
}): CreateAutonomousGoalIfNoneActiveResult {
  if (!input.goalId || !input.prompt || !Number.isInteger(input.maxCycles) || input.maxCycles < 1) {
    throw new Error("goalId, prompt, and a positive integer maxCycles are required");
  }
  let existingGoalId: string | null = null;
  let created = false;
  db.runInTransaction(() => {
    const active = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' ORDER BY created_at DESC, goal_id DESC").all() as Array<{ goal_id: string }>;
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous start");
    if (active.length === 1) {
      existingGoalId = active[0].goal_id;
      return;
    }
    const route = input.supervisorRoute ? boundedSupervisorRoute(input.supervisorRoute) : null;
    db.raw.prepare(`INSERT INTO autonomous_goals
      (goal_id, prompt, constraints_json, bot, max_cycles, evidence_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.goalId, input.prompt, JSON.stringify(input.constraints), input.bot, input.maxCycles, JSON.stringify((input.initialEvidence ?? []).slice(-8)));
    scheduleWake(db, input.goalId, { key: `${input.goalId}:wake:0`, reason: "initial" });
    if (route) {
      db.setSetting(supervisorSettingKey(input.goalId), JSON.stringify({ route, messageIds: [] } satisfies AutonomousSupervisorState));
    }
    created = true;
  });
  const goal = getAutonomousGoal(db, existingGoalId ?? input.goalId);
  return { goal, created };
}

export function recordAutonomousSupervisorInput(db: BridgeDb, input: {
  goalId: string;
  text: string;
  idempotencyKey: string;
}): boolean {
  const text = input.text.trim();
  if (!text || text.length > MAX_AUTONOMOUS_SUPERVISOR_INPUT_CHARS) throw new Error("autonomous supervisor input must be bounded and non-empty");
  if (!input.idempotencyKey || input.idempotencyKey.length > 512) throw new Error("invalid autonomous supervisor input idempotency key");
  return db.runInTransaction(() => {
    const goal = getAutonomousGoal(db, input.goalId);
    if (goal.status !== "active") return false;
    if (db.getEventReceiptByIdempotencyKey(input.idempotencyKey)) return true;
    db.createEventReceipt({
      event_id: input.idempotencyKey,
      source: AUTONOMOUS_EVENT_SOURCE,
      event_kind: AUTONOMOUS_SUPERVISOR_INPUT_KIND,
      idempotency_key: input.idempotencyKey,
      received_at: new Date().toISOString(),
      occurred_at: new Date().toISOString(),
      payload_json: JSON.stringify({ goalId: input.goalId, text }),
      authority_scope: AUTONOMOUS_RUN_AUTHORITY_SCOPE,
    });
    return true;
  });
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

function extractAutonomousResultJson(text: string): string {
  const candidate = parseEnvelope(text).trim();
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Fall through only to the explicitly supported fenced form.
  }
  const fences = [...candidate.matchAll(/(?:^|\r?\n)[ \t]*```json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/gi)];
  if (fences.length !== 1) throw new Error("malformed autonomous cycle result");
  return fences[0][1].trim();
}

export function parseAutonomousCycleResult(text: string): AutonomousCycleResult {
  let parsed: unknown;
  try { parsed = JSON.parse(extractAutonomousResultJson(text)); } catch { throw new Error("malformed autonomous cycle result"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("malformed autonomous cycle result");
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["evidence", "nextWakeReason", "status", "supervisorMessage"].includes(key))) throw new Error("unknown autonomous cycle result field");
  if (!["progress", "complete", "blocked", "cancelled"].includes(value.status as string)) throw new Error("invalid autonomous cycle status");
  if (typeof value.evidence !== "string" || value.evidence.length > MAX_EVIDENCE_CHARS) throw new Error("invalid autonomous cycle evidence");
  if (value.nextWakeReason !== undefined && (typeof value.nextWakeReason !== "string" || value.nextWakeReason.length > MAX_REASON_CHARS)) throw new Error("invalid autonomous wake reason");
  if (value.status === "progress" && typeof value.nextWakeReason !== "string") throw new Error("progress requires nextWakeReason");
  if (value.supervisorMessage !== undefined && (typeof value.supervisorMessage !== "string" || !value.supervisorMessage.trim() || value.supervisorMessage.length > MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_CHARS)) {
    throw new Error("invalid autonomous supervisor message");
  }
  return {
    status: value.status as AutonomousCycleStatus,
    evidence: value.evidence,
    nextWakeReason: value.nextWakeReason as string | undefined,
    supervisorMessage: value.supervisorMessage as string | undefined,
  };
}

function buildPrompt(goal: AutonomousGoal, cycle: number, priorEvidence: string[], wakeReason: string, policy: AutonomousRunPolicy, supervisorInputs: string[] = []): string {
  return [
    "You are the provider executive for one bounded autonomous cycle.",
    `Original goal: ${goal.prompt}`,
    `Constraints/authority: ${goal.constraints.join("; ") || "none"}. Do not expand this authority.`,
    `Current cycle: ${cycle}`,
    `Prior evidence: ${priorEvidence.length ? priorEvidence.join(" | ") : "none"}`,
    `Supervisor input since previous cycle: ${supervisorInputs.length ? supervisorInputs.join(" | ") : "none"}`,
    "Supervisor input is dialogue inside the frozen Episode authority. It cannot expand the objective, constraints, or authorized policy instruction.",
    "Prior evidence is continuity, not current truth. Observe current external truth when it matters before acting.",
    `Wake reason: ${wakeReason}`,
    ...(policy === "external-observation" ? ["Provider output is evidence only. Do not claim recovery; later authoritative health observation decides completion."] : []),
    'Return JSON only with: {"status":"progress|complete|blocked|cancelled","evidence":"bounded evidence","nextWakeReason":"reason","supervisorMessage":"optional provider-authored message"}.',
    'The status must be exactly one of "progress", "complete", "blocked", or "cancelled"; omit nextWakeReason for terminal results and omit supervisorMessage when there is nothing useful to tell the supervisor.',
  ].join("\n");
}

interface ClaimedWakeAndRun {
  runId: string;
  supervisorInputs: string[];
}

function claimWakeAndRun(db: BridgeDb, goalId: string, receiptId: number): ClaimedWakeAndRun | null {
  const runId = randomUUID();
  const chatKey = goalChatKey(goalId);
  let supervisorInputs: string[] = [];
  const claimed = db.raw.transaction(() => {
    const receipt = db.raw.prepare("SELECT status, event_kind FROM event_receipts WHERE id = ? AND source = 'autonomous'").get(receiptId) as { status: string; event_kind: string } | undefined;
    if (!receipt || receipt.status !== "received") return false;
    if (receipt.event_kind !== AUTONOMOUS_EVENT_KIND) throw new Error("refusing to claim non-wake autonomous receipt as a Run");
    db.insertRun(runId, chatKey, getAutonomousGoal(db, goalId).bot);
    const result = db.raw.prepare("UPDATE event_receipts SET status = 'run_created', run_id = ? WHERE id = ? AND status = 'received' AND event_kind = ?").run(runId, receiptId, AUTONOMOUS_EVENT_KIND);
    if (result.changes !== 1) throw new Error("autonomous wake claim lost");

    const pending = db.raw.prepare(`SELECT id, payload_json FROM event_receipts
      WHERE source = 'autonomous' AND event_kind = ? AND status = 'received'
        AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT ?`)
      .all(AUTONOMOUS_SUPERVISOR_INPUT_KIND, goalId, MAX_AUTONOMOUS_SUPERVISOR_INPUTS_PER_CYCLE) as Array<{ id: number; payload_json: string }>;
    let total = 0;
    const claimInput = db.raw.prepare("UPDATE event_receipts SET status = 'run_created', run_id = ? WHERE id = ? AND status = 'received' AND event_kind = ?");
    for (const row of pending) {
      let text = "";
      try {
        const payload = JSON.parse(row.payload_json) as { text?: unknown };
        text = typeof payload.text === "string" ? payload.text.trim() : "";
      } catch {
        // handled below as malformed input
      }
      if (!text || text.length > MAX_AUTONOMOUS_SUPERVISOR_INPUT_CHARS) {
        db.raw.prepare("UPDATE event_receipts SET status = 'failed', error_class = 'malformed_supervisor_input' WHERE id = ? AND status = 'received'").run(row.id);
        continue;
      }
      if (total + text.length > MAX_AUTONOMOUS_SUPERVISOR_INPUT_TOTAL_CHARS) break;
      if (claimInput.run(runId, row.id, AUTONOMOUS_SUPERVISOR_INPUT_KIND).changes !== 1) throw new Error("autonomous supervisor input claim lost");
      supervisorInputs.push(text);
      total += text.length;
    }
    return true;
  })();
  return claimed ? { runId, supervisorInputs } : null;
}

function pendingWake(db: BridgeDb, goalId: string): any | null {
  return db.raw.prepare(`SELECT * FROM event_receipts
    WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'
      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1`).get(goalId) ?? null;
}

function recoverableWake(db: BridgeDb, goalId: string): any | null {
  return db.raw.prepare(`SELECT * FROM event_receipts
    WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'run_created'
      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1`).get(goalId) ?? null;
}

function settleSupervisorInputsForRun(db: BridgeDb, runId: string, status: "completed" | "failed" | "cancelled", errorClass?: string): void {
  db.raw.prepare(`UPDATE event_receipts SET status = ?, error_class = ?, result_reference = ?
    WHERE source = 'autonomous' AND event_kind = ? AND status = 'run_created' AND run_id = ?`)
    .run(status, errorClass ?? null, runId, AUTONOMOUS_SUPERVISOR_INPUT_KIND, runId);
}

function retirePendingSupervisorInputs(db: BridgeDb, goalId: string, errorClass: string): void {
  db.raw.prepare(`UPDATE event_receipts SET status = 'cancelled', error_class = ?
    WHERE source = 'autonomous' AND event_kind = ? AND status = 'received'
      AND json_extract(payload_json, '$.goalId') = ?`)
    .run(errorClass, AUTONOMOUS_SUPERVISOR_INPUT_KIND, goalId);
}

function boundedEvidence(goal: AutonomousGoal, evidence: string): string[] {
  const nextEvidence: string[] = [];
  for (const item of [...goal.evidence, evidence].reverse()) {
    const candidate = [...nextEvidence, item];
    if (candidate.join("\n").length > MAX_TOTAL_EVIDENCE_CHARS) break;
    nextEvidence.unshift(item);
  }
  return nextEvidence;
}

/**
 * A claimed wake is deliberately never replayed after restart: the provider
 * boundary may already have been crossed before the process died. Reconcile
 * the orphaned ordinary Run and terminate the goal with bounded evidence.
 */
function recoverUnreconciledWake(db: BridgeDb, goal: AutonomousGoal, receipt: any): void {
  db.runInTransaction(() => {
    const run = receipt.run_id ? db.getRun(receipt.run_id) : null;
    const evidence = "recovered claimed autonomous wake without reconciliation; provider result not replayed";
    const status = run?.status === "cancelled" ? "cancelled" : "blocked";
    if (run && run.status !== "cancelled") {
      db.raw.prepare("UPDATE bridge_runs SET status = 'failed', ended_at = CURRENT_TIMESTAMP, error = ? WHERE run_id = ? AND status IN ('running', 'done')")
        .run("autonomous wake orphaned during restart", run.run_id);
    }
    db.raw.prepare("UPDATE event_receipts SET status = ?, error_class = ?, result_reference = ? WHERE id = ? AND status = 'run_created'")
      .run(status === "cancelled" ? "cancelled" : "failed", "restart_recovery", receipt.run_id ?? null, receipt.id);
    db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?")
      .run(goal.cycle + 1, status, JSON.stringify(boundedEvidence(goal, evidence)), goal.goalId);
    settleSupervisorInputsForRun(db, receipt.run_id ?? "", status === "cancelled" ? "cancelled" : "failed", "restart_recovery");
    retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
  });
}

function reconcile(db: BridgeDb, goal: AutonomousGoal, receipt: any, runId: string, result: AutonomousCycleResult | null, error: string | undefined, policy: AutonomousRunPolicy): void {
  db.runInTransaction(() => {
    const run = db.getRun(runId);
    const currentGoal = getAutonomousGoal(db, goal.goalId);
    const evidence = result?.evidence ?? error ?? "malformed provider output";
    const nextEvidence = boundedEvidence(goal, evidence);
    if (currentGoal.status !== "active") {
      if (run?.status === "running") db.updateRunCompleted(runId, evidence, null);
      db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "completed");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;
    }
    if (run?.status === "cancelled") {
      db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = 'cancelled', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?").run(goal.cycle + 1, JSON.stringify(nextEvidence), goal.goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "cancelled", "goal_cancelled");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;
    }
    if (!result) {
      db.raw.prepare("UPDATE bridge_runs SET status = 'failed', ended_at = CURRENT_TIMESTAMP, error = ? WHERE run_id = ? AND status IN ('running', 'done')")
        .run(error ?? "malformed autonomous cycle result", runId);
      db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = 'blocked', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?").run(goal.cycle + 1, JSON.stringify(nextEvidence), goal.goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'failed', error_class = ?, result_reference = ? WHERE id = ? AND status = 'run_created'").run("malformed_result", runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "failed", "malformed_result");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;
    }
    db.updateRunCompleted(runId, result.evidence, null);
    db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
    settleSupervisorInputsForRun(db, runId, "completed");
    const nextStatus: AutonomousGoalStatus = result.status === "progress"
      ? (goal.cycle + 1 >= goal.maxCycles && policy === "provider" ? "budget_exhausted" : "active")
      : result.status;
    db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?")
      .run(goal.cycle + 1, nextStatus, JSON.stringify(nextEvidence), goal.goalId);
    if (policy === "provider" && result.status === "progress" && nextStatus === "active") {
      scheduleWake(db, goal.goalId, { key: `${goal.goalId}:wake:${goal.cycle + 1}`, reason: result.nextWakeReason! });
    } else if (nextStatus !== "active") {
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
    }
  });
}

// Provider-neutral observation point after a cycle has already been parsed
// and reconciled (#326) — no raw provider stdout, transcript, hidden
// reasoning, or tool logs, only existing bounded autonomous-goal fields.
export interface CycleReconciledEvent {
  type: "autonomous_cycle_reconciled";
  goalId: string;
  cycle: number;
  runId: string;
  goalStatus: AutonomousGoalStatus;
  cycleStatus: AutonomousCycleStatus;
  evidence: string;
  supervisorMessage?: string;
}

export async function runNextAutonomousGoal(
  db: BridgeDb,
  goalId: string,
  engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">,
  onCycleReconciled?: (event: CycleReconciledEvent) => void,
): Promise<boolean> {
  const goal = getAutonomousGoal(db, goalId);
  const policy = policyForGoal(goal);
  if (goal.status !== "active") return false;
  const wake = pendingWake(db, goalId);
  const claimed = recoverableWake(db, goalId);
  if (!wake && !claimed) return false;
  const laneHandle: ExecutionLaneHandle | null = db.acquireLock(AUTONOMOUS_RUN_SURFACE, goalChatKey(goalId));
  if (!laneHandle) throw new AutonomousGoalLaneUnavailableError(goalId);
  try {
    const current = getAutonomousGoal(db, goalId);
    const currentPolicy = policyForGoal(current);
    const currentClaimed = recoverableWake(db, goalId);
    if (current.status !== "active") return false;
    if (currentClaimed) {
      recoverUnreconciledWake(db, current, currentClaimed);
      return true;
    }
    const currentWake = pendingWake(db, goalId);
    if (!currentWake) return false;
    if (current.cycle >= current.maxCycles) {
      // A wake can be scheduled by a concurrent authoritative health
      // observation before this cycle's own reconcile() commits the
      // incremented cycle count (see applyAuthoritativeHealthObservation).
      // Re-check the budget here, at the one place a new Run is actually
      // claimed, so that race can never start a Run beyond maxCycles.
      db.runInTransaction(() => {
        db.raw.prepare("UPDATE autonomous_goals SET status = 'budget_exhausted', updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'").run(goalId);
        db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'budget_exhausted' WHERE id = ? AND status = 'received' AND event_kind = ?").run(currentWake.id, AUTONOMOUS_EVENT_KIND);
        retirePendingSupervisorInputs(db, goalId, "budget_exhausted");
      });
      return false;
    }
    const claim = claimWakeAndRun(db, goalId, currentWake.id);
    if (!claim) return false;
    const { runId, supervisorInputs } = claim;
    const eventStore = new EventStore(db, runId);
    const input: SurfaceNeutralTurnInput = {
      prompt: buildPrompt(current, current.cycle + 1, current.evidence, JSON.parse(currentWake.payload_json).reason, currentPolicy, supervisorInputs),
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
    const effectiveResult = currentPolicy === "external-observation" && parsed?.status === "complete"
      ? { ...parsed, status: "progress" as const, nextWakeReason: undefined }
      : parsed;
    reconcile(db, current, currentWake, runId, effectiveResult, error, currentPolicy);
    if (onCycleReconciled) {
      try {
        const after = getAutonomousGoal(db, goalId);
        onCycleReconciled({
          type: "autonomous_cycle_reconciled",
          goalId,
          cycle: after.cycle,
          runId,
          goalStatus: after.status,
          cycleStatus: effectiveResult?.status ?? "blocked",
          evidence: effectiveResult?.evidence ?? error ?? "malformed provider output",
          ...(effectiveResult?.supervisorMessage ? { supervisorMessage: effectiveResult.supervisorMessage } : {}),
        });
      } catch {
        // Observer failures must never affect cycle ownership or reconciled
        // state — reconciliation above has already committed successfully.
      }
    }
    return true;
  } finally {
    db.unlock(laneHandle);
  }
}

export async function drainAutonomousGoal(
  db: BridgeDb,
  goalId: string,
  engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">,
  onCycleReconciled?: (event: CycleReconciledEvent) => void,
): Promise<void> {
  while (getAutonomousGoal(db, goalId).status === "active") {
    const progressed = await runNextAutonomousGoal(db, goalId, engine, onCycleReconciled);
    if (!progressed && getAutonomousGoal(db, goalId).status === "active") throw new AutonomousGoalProgressError(goalId);
  }
}

const HEALTH_CORRELATION_PREFIX = "health-gap-correlation:";

function boundedHealthEvidence(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_EVIDENCE_CHARS) {
    throw new Error("health observation evidence must be bounded and non-empty");
  }
  return value;
}

function boundedHealthObjective(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_EVIDENCE_CHARS) {
    throw new Error("health recovery objective must be bounded and non-empty");
  }
  return value;
}

function healthCorrelationConstraint(correlationId: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(correlationId)) throw new Error("invalid health correlation id");
  return `${HEALTH_CORRELATION_PREFIX}${correlationId}`;
}

export function healthRecoveryGoalId(correlationId: string): string {
  healthCorrelationConstraint(correlationId);
  return `health-recovery:${correlationId}`;
}

export function healthReportCorrelationId(pluginName: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(pluginName)) throw new Error("invalid health plugin name");
  return `health-report:${pluginName}`;
}

/** Applies one later authoritative health report to owner-authorized goals.
 * It only returns goals with a newly-created successor wake; callers keep the
 * existing ordinary Run executor responsible for running those wakes. */
export function applyAuthoritativeHealthReport(
  db: BridgeDb,
  report: { pluginName: string; status: "green" | "amber" | "red"; summary: string; timestamp: string },
): string[] {
  const correlationId = healthReportCorrelationId(report.pluginName);
  const status = report.status === "green" ? "healthy" : report.status === "red" ? "unhealthy" : "unknown";
  const goalId = healthRecoveryGoalId(correlationId);
  try {
    if (getAutonomousGoal(db, goalId).status !== "active") return [];
  } catch {
    return [];
  }
  const outcome = applyAuthoritativeHealthObservation(db, goalId, {
    status, evidence: report.summary, correlationId, observedAt: report.timestamp,
  });
  return outcome === "active" && pendingWake(db, goalId) ? [goalId] : [];
}

export function pendingOwnerAuthorizedHealthRecoveryGoals(db: BridgeDb): string[] {
  const rows = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' AND constraints_json LIKE ?")
    .all(`%${HEALTH_POLICY_CONSTRAINT}%`) as Array<{ goal_id: string }>;
  return rows.filter((row) => pendingWake(db, row.goal_id) !== null).map((row) => row.goal_id);
}

function policyForGoal(goal: AutonomousGoal): AutonomousRunPolicy {
  return goal.constraints.includes(HEALTH_POLICY_CONSTRAINT) ? "external-observation" : "provider";
}

function validateHealthRequest(input: OwnerAuthorizedHealthRecoveryRequest, correlationConstraint: string): void {
  if (input.ownerAction !== "investigate") throw new Error("owner Investigate action is required");
  if (input.goalId !== healthRecoveryGoalId(input.correlationId)) throw new Error("health recovery goal id must match correlation");
  boundedHealthObjective(input.objective);
  boundedHealthEvidence(input.healthEvidence);
  if (!Array.isArray(input.constraints) || input.constraints.length > MAX_HEALTH_CONSTRAINTS ||
      input.constraints.some((item) => typeof item !== "string" || item.length === 0 || item.length > MAX_HEALTH_CONSTRAINT_CHARS) ||
      input.constraints.join("\n").length > MAX_HEALTH_CONSTRAINT_TOTAL) throw new Error("health recovery constraints are not bounded");
  if (!(input.bot === "codex" || input.bot === "claude" || input.bot === "antigravity")) throw new Error("unsupported health recovery provider");
  if (!Number.isInteger(input.maxCycles) || input.maxCycles < 1 || input.maxCycles > MAX_HEALTH_CYCLES) throw new Error("health recovery cycle budget is not bounded");
}

/**
 * Owner authorization boundary for a health investigation. Health evidence
 * alone never calls this function. A stable goal id is the existing durable
 * correlation key, while the ordinary autonomous Run owner executes the first
 * bounded cycle through BridgeEngine.
 */
export async function startOwnerAuthorizedHealthRecovery(
  db: BridgeDb,
  input: OwnerAuthorizedHealthRecoveryRequest,
  engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">,
): Promise<{ goalId: string; runId: string | null; status: AutonomousGoalStatus }> {
  const correlationConstraint = healthCorrelationConstraint(input.correlationId);
  validateHealthRequest(input, correlationConstraint);
  let goal: AutonomousGoal;
  try {
    goal = getAutonomousGoal(db, input.goalId);
  } catch {
    goal = createAutonomousGoal(db, {
      goalId: input.goalId,
      prompt: `${input.objective}\nHealth gap correlation: ${input.correlationId}`,
      constraints: [...input.constraints, correlationConstraint, HEALTH_POLICY_CONSTRAINT],
      bot: input.bot,
      maxCycles: input.maxCycles,
      initialEvidence: [`authoritative health observation: ${input.healthEvidence}`],
    });
  }
  if (!goal.constraints.includes(correlationConstraint)) throw new Error("health correlation does not match existing goal");
  if (!goal.constraints.includes(HEALTH_POLICY_CONSTRAINT)) throw new Error("health recovery goal has no durable external-observation policy");
  await runNextAutonomousGoal(db, input.goalId, engine);
  const latest = db.raw.prepare("SELECT run_id FROM bridge_runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(goalChatKey(input.goalId)) as { run_id?: string } | undefined;
  return { goalId: input.goalId, runId: latest?.run_id ?? null, status: getAutonomousGoal(db, input.goalId).status };
}

/** Runs one already-authorized successor wake through the ordinary Run owner. */
export async function runOwnerAuthorizedHealthRecovery(
  db: BridgeDb,
  goalId: string,
  engine: Pick<BridgeEngine, "executeSurfaceNeutralTurn">,
): Promise<boolean> {
  return runNextAutonomousGoal(db, goalId, engine);
}

/**
 * Applies later authoritative health evidence. Provider prose is never read
 * here. Healthy completes the goal, unhealthy creates one idempotent successor
 * wake if budget remains, and unknown stops safely as blocked.
 */
export function applyAuthoritativeHealthObservation(
  db: BridgeDb,
  goalId: string,
  observation: AuthoritativeHealthObservation,
): AutonomousGoalStatus {
  const correlationConstraint = healthCorrelationConstraint(observation.correlationId);
  if (typeof observation.observedAt !== "string" || observation.observedAt.length > 64 || Number.isNaN(Date.parse(observation.observedAt))) throw new Error("invalid health observation timestamp");
  const observationKey = `${goalId}:health-observation:${observation.observedAt}:${observation.status}`;
  const observationEvidence = `observedAt=${observation.observedAt}; ${observation.evidence}`;
  const evidence = boundedHealthEvidence(observationEvidence);
  return db.runInTransaction(() => {
    const goal = getAutonomousGoal(db, goalId);
    if (!goal.constraints.includes(correlationConstraint)) throw new Error("health correlation does not match goal");
    if (goal.status !== "active") return goal.status;
    const nextEvidence = boundedEvidence(goal, `authoritative health observation: ${observation.status}; ${evidence}`);
    const latestRun = db.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(goalChatKey(goalId)) as { status?: string } | undefined;
    if (latestRun?.status === "cancelled") {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'cancelled', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'goal_cancelled' WHERE source = 'autonomous' AND status = 'received' AND json_extract(payload_json, '$.goalId') = ?")
        .run(goalId);
      return "cancelled";
    }
    if (observation.status === "healthy") {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'complete', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'health_recovered' WHERE source = 'autonomous' AND status = 'received' AND json_extract(payload_json, '$.goalId') = ?")
        .run(goalId);
      return "complete";
    }
    if (observation.status === "unknown") {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'blocked', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'health_unknown' WHERE source = 'autonomous' AND status = 'received' AND json_extract(payload_json, '$.goalId') = ?")
        .run(goalId);
      return "blocked";
    }
    if (goal.cycle >= goal.maxCycles) {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'budget_exhausted', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      retirePendingSupervisorInputs(db, goalId, "budget_exhausted");
      return "budget_exhausted";
    }
    db.raw.prepare("UPDATE autonomous_goals SET evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
      .run(JSON.stringify(nextEvidence), goalId);
    if (db.getEventReceiptByIdempotencyKey(observationKey) || pendingWake(db, goalId)) return "active";
    scheduleWake(db, goalId, {
      key: observationKey,
      reason: `authoritative health observation: ${evidence}`,
    });
    return "active";
  });
}

/**
 * Emergency stop for an active autonomous goal, through existing Agent
 * Bridge cancellation/fencing ownership rather than a new company executor
 * (#326). Idempotent: cancelling an already-terminal goal is a safe no-op.
 *
 * If a run is currently in flight, cancellation first claims the existing
 * durable Run fence with updateRunCancelled(). Only after that fence wins do
 * we terminate the cross-process descendants identified by AGENT_BRIDGE_RUN_ID.
 * This ordering matters: killing the provider can make the separate run
 * process settle immediately, so the durable cancellation must already be
 * visible before reconcile() gets a chance to persist progress or a successor.
 * The existing reconcile() cancellation-race path then finalizes the goal to
 * cancelled. If the fence loses, another terminal Run transition already won;
 * return current durable state rather than claiming a stop that did not win.
 * If no run is currently in flight, there is nothing to kill and the goal plus
 * any pending wake are cancelled directly.
 */
export async function cancelAutonomousGoal(
  db: BridgeDb,
  goalId: string,
  reason: string,
  options?: { killRunOwnedDescendants?: (runId: string) => Promise<void> },
): Promise<AutonomousGoal> {
  const goal = getAutonomousGoal(db, goalId);
  if (goal.status !== "active") return goal;
  const kill = options?.killRunOwnedDescendants ?? killRunOwnedDescendants;
  const latestRun = db.raw.prepare("SELECT run_id, status FROM bridge_runs WHERE chat_id = ? ORDER BY started_at DESC LIMIT 1").get(goalChatKey(goalId)) as { run_id?: string; status?: string } | undefined;
  if (latestRun?.run_id && latestRun.status === "running") {
    const fenced = db.updateRunCancelled(latestRun.run_id, reason);
    if (!fenced) return getAutonomousGoal(db, goalId);
    await kill(latestRun.run_id);
    return getAutonomousGoal(db, goalId);
  }
  db.runInTransaction(() => {
    const nextEvidence = boundedEvidence(goal, `cancelled: ${reason}`);
    const result = db.raw.prepare("UPDATE autonomous_goals SET status = 'cancelled', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
      .run(JSON.stringify(nextEvidence), goalId);
    if (result.changes === 1) {
      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'owner_stopped' WHERE source = 'autonomous' AND status = 'received' AND json_extract(payload_json, '$.goalId') = ?")
        .run(goalId);
    }
  });
  return getAutonomousGoal(db, goalId);
}

export async function runAutonomousGoalOperator(
  db: BridgeDb,
  args: string[],
  engine?: Pick<BridgeEngine, "executeSurfaceNeutralTurn">,
  onCycleReconciled?: (event: CycleReconciledEvent) => void,
): Promise<AutonomousGoal> {
  const [operation, goalId] = args;
  if (operation === "cancel") return cancelAutonomousGoal(db, goalId, args.slice(2).join(" ") || "owner stop");
  if (operation === "create") {
    const maxIndex = args.indexOf("--max-cycles");
    const constraintsIndex = args.indexOf("--constraints");
    const botIndex = args.indexOf("--bot");
    const promptEnd = Math.min(
      ...[maxIndex, constraintsIndex, botIndex].filter((index) => index !== -1),
      args.length,
    );
    const prompt = args.slice(2, promptEnd).join(" ");
    const maxCycles = Number(maxIndex === -1 ? 3 : args[maxIndex + 1]);
    // Default preserved exactly for backward compatibility. A caller with
    // its own durable constraints (e.g. a company operating contract) and
    // provider passes --constraints (pipe-delimited) / --bot explicitly
    // rather than being forced into the operator-approved default.
    const constraints = constraintsIndex === -1
      ? ["operator-approved goal authority"]
      : args[constraintsIndex + 1].split("|").map((constraint) => constraint.trim()).filter(Boolean);
    const bot: BotKind = botIndex === -1 ? "claude" : args[botIndex + 1] as BotKind;
    return createAutonomousGoal(db, { goalId, prompt, constraints, bot, maxCycles });
  }
  if (operation === "status") return getAutonomousGoal(db, goalId);
  if (operation === "run" && engine) {
    await drainAutonomousGoal(db, goalId, engine, onCycleReconciled);
    return getAutonomousGoal(db, goalId);
  }
  throw new Error("usage: create <goal-id> <prompt> [--constraints c1|c2] [--bot name] [--max-cycles N] | run <goal-id> | status <goal-id> | cancel <goal-id> [reason...]");
}

// Resolves a durable goal's bot to the same provider command/config the
// interactive bridge already uses (loadBotsConfig — CODEX_COMMAND,
// CLAUDE_COMMAND, ANTIGRAVITY_COMMAND/GEMINI_COMMAND env overrides) and the
// same execution-mode resolution (resolveExecutionMode — per-bot
// <BOT>_EXECUTION_MODE, then global BRIDGE_EXECUTION_MODE, then "safe").
// Throws rather than silently defaulting to Claude for a bot with no
// launchable command (e.g. "kimchi" is a valid BotKind but has no
// loadBotsConfig entry).
export function standaloneBotConfig(bot: BotKind): { executionKind: BotKind; botConfig: BotConfig; executionMode: "safe" | "trusted" } {
  const bots = loadBotsConfig(process.env);
  const botConfig = (bots as Record<string, BotConfig | undefined>)[bot];
  if (!botConfig) throw new Error(`no launchable provider command configured for bot "${bot}"`);
  return { executionKind: bot, botConfig, executionMode: resolveExecutionMode(bot, process.env) };
}

// Resolves Soul context exactly as index-interactive.ts does — same
// defaultSoulPath/normalizeSoulMode/loadSoulContext functions, same env
// vars (AGENT_BRIDGE_SOUL_PATH, AGENT_BRIDGE_SOUL_MODE) — so interactive
// and standalone execution receive the same configured Soul (#326). No new
// Soul loader; provider-neutral and content-free of any company identity.
export function standaloneSoulContext(env: NodeJS.ProcessEnv = process.env): string | null {
  return loadSoulContext({
    mode: normalizeSoulMode(env.AGENT_BRIDGE_SOUL_MODE),
    path: env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(env.BRIDGE_PROJECT_DIR || process.cwd()),
  });
}

export function buildStandaloneEngine(db: BridgeDb, bot: BotKind): BridgeEngine {
  const { executionKind, botConfig, executionMode } = standaloneBotConfig(bot);
  const client = { getUpdates: async () => ({ result: [], ok: true }), sendMessage: async () => ({ ok: true }), sendChatAction: async () => ({ ok: true }) } as any;
  return new BridgeEngine({
    surfaceIdentity: AUTONOMOUS_RUN_SURFACE, kind: "autonomous", executionKind, botConfig,
    allowedUserIds: new Set(["operator"]), executionMode, asyncEnabled: true, pollIntervalMs: 1000,
    soulContext: standaloneSoulContext(),
  }, db, client);
}

/**
 * Genuinely runnable single-call operator seam over the existing
 * create/run/status machinery, for a caller (e.g. a company-owned goal
 * bootstrap script) that is not the interactive bridge process and has no
 * existing engine to hand in. Opens the given database and, only for "run"
 * (the only operation that needs one), constructs an engine for the durable
 * goal's own stored bot — never a hard-coded default — via the same
 * standalone construction runAutonomousGoalLiveSmoke used (or an injected
 * override for tests). Delegates to runAutonomousGoalOperator and closes
 * the database. Not a new executor — engineFactory just parameterizes the
 * existing live-smoke construction pattern.
 */
export async function runAutonomousGoalOperatorStandalone(
  databasePath: string,
  args: string[],
  options?: {
    engineFactory?: (db: BridgeDb, bot: BotKind) => Pick<BridgeEngine, "executeSurfaceNeutralTurn">;
    onCycleReconciled?: (event: CycleReconciledEvent) => void;
  },
): Promise<AutonomousGoal> {
  const db = openProductionDb(databasePath, { serviceId: "autonomous-goal-operator", runId: randomUUID() });
  try {
    const [operation, goalId] = args;
    const engine = operation === "run"
      ? (options?.engineFactory ?? buildStandaloneEngine)(db, getAutonomousGoal(db, goalId).bot)
      : undefined;
    return await runAutonomousGoalOperator(db, args, engine, options?.onCycleReconciled);
  } finally {
    db.close();
  }
}

export async function runAutonomousGoalLiveSmoke(databasePath: string): Promise<{ providerBoundaryReached: boolean; status: AutonomousGoalStatus }> {
  const db = openProductionDb(databasePath, { serviceId: "autonomous-live-smoke", runId: randomUUID() });
  const command = process.env.AGENT_BRIDGE_AUTONOMOUS_PROVIDER_COMMAND ?? "claude";
  const client = { getUpdates: async () => ({ result: [], ok: true }), sendMessage: async () => ({ ok: true }), sendChatAction: async () => ({ ok: true }) } as any;
  const engine = new BridgeEngine({ surfaceIdentity: AUTONOMOUS_RUN_SURFACE, kind: "autonomous", executionKind: "claude", botConfig: { command, modelPreference: ["default"] }, allowedUserIds: new Set(["operator"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000 }, db, client);
  let providerBoundaryReached = false;
  const executeSurfaceNeutralTurn = engine.executeSurfaceNeutralTurn.bind(engine);
  engine.executeSurfaceNeutralTurn = async (input) => {
    providerBoundaryReached = true;
    return executeSurfaceNeutralTurn(input);
  };
  const goalId = `live-smoke-${randomUUID()}`;
  createAutonomousGoal(db, { goalId, prompt: "Return a bounded JSON result only; do not modify files or contact external systems.", constraints: ["non-destructive smoke only"], bot: "claude", maxCycles: 1 });
  await drainAutonomousGoal(db, goalId, engine);
  const status = getAutonomousGoal(db, goalId).status;
  db.close();
  return { providerBoundaryReached, status };
}
