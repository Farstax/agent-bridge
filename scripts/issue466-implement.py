#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text()

def write(path, text):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# First-class autonomous runtime: widen the existing goal runtime only where
# the approved #466 plan requires it. No new schema or second execution stack.
# ---------------------------------------------------------------------------
path = "src/autonomousGoalRuntime.ts"
s = read(path)

s = replace_once(s,
'''export const AUTONOMOUS_EVENT_KIND = "goal_wake" as const;
export const AUTONOMOUS_RUN_SURFACE = "autonomous" as const;''',
'''export const AUTONOMOUS_EVENT_KIND = "goal_wake" as const;
export const AUTONOMOUS_SUPERVISOR_INPUT_KIND = "supervisor_input" as const;
export const AUTONOMOUS_RUN_SURFACE = "autonomous" as const;''', "runtime event kinds")

s = replace_once(s,
'''const MAX_EVIDENCE_CHARS = 2_000;
const MAX_TOTAL_EVIDENCE_CHARS = 8_000;
const MAX_REASON_CHARS = 300;''',
'''const MAX_EVIDENCE_CHARS = 2_000;
const MAX_TOTAL_EVIDENCE_CHARS = 8_000;
const MAX_REASON_CHARS = 300;
export const MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_CHARS = 3_000;
export const MAX_AUTONOMOUS_SUPERVISOR_INPUT_CHARS = 3_000;
const MAX_AUTONOMOUS_SUPERVISOR_INPUT_TOTAL_CHARS = 6_000;
const MAX_AUTONOMOUS_SUPERVISOR_INPUTS_PER_CYCLE = 8;
const MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_IDS = 32;
const MAX_AUTONOMOUS_SUPERVISOR_ROUTE_FIELD_CHARS = 256;
const AUTONOMOUS_SUPERVISOR_SETTING_PREFIX = "autonomy:supervisor:";''', "runtime bounds")

s = replace_once(s,
'''export interface AutonomousCycleResult {
  status: AutonomousCycleStatus;
  evidence: string;
  nextWakeReason?: string;
}''',
'''export interface AutonomousCycleResult {
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
}''', "runtime cycle type")

# Add supervisor state helpers and atomic create-if-none-active immediately after
# the legacy create helper. The legacy API stays source-compatible for health and
# operator callers.
create_anchor = '''export function createAutonomousGoal(db: BridgeDb, input: {
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
'''
create_replacement = create_anchor + r'''
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
'''
s = replace_once(s, create_anchor, create_replacement, "runtime create helpers")

# Cycle parser accepts a bounded optional provider-authored message.
s = replace_once(s,
'''  if (keys.some((key) => !["evidence", "nextWakeReason", "status"].includes(key))) throw new Error("unknown autonomous cycle result field");''',
'''  if (keys.some((key) => !["evidence", "nextWakeReason", "status", "supervisorMessage"].includes(key))) throw new Error("unknown autonomous cycle result field");''', "runtime parser keys")
s = replace_once(s,
'''  if (value.status === "progress" && typeof value.nextWakeReason !== "string") throw new Error("progress requires nextWakeReason");
  return { status: value.status as AutonomousCycleStatus, evidence: value.evidence, nextWakeReason: value.nextWakeReason as string | undefined };''',
'''  if (value.status === "progress" && typeof value.nextWakeReason !== "string") throw new Error("progress requires nextWakeReason");
  if (value.supervisorMessage !== undefined && (typeof value.supervisorMessage !== "string" || !value.supervisorMessage.trim() || value.supervisorMessage.length > MAX_AUTONOMOUS_SUPERVISOR_MESSAGE_CHARS)) {
    throw new Error("invalid autonomous supervisor message");
  }
  return {
    status: value.status as AutonomousCycleStatus,
    evidence: value.evidence,
    nextWakeReason: value.nextWakeReason as string | undefined,
    supervisorMessage: value.supervisorMessage as string | undefined,
  };''', "runtime parser message")

# Prompt keeps authority, prior evidence, supervisor input and current truth as
# separate concepts. It tells the provider the transport contract but does not
# generate any narrative itself.
old_build = '''function buildPrompt(goal: AutonomousGoal, cycle: number, priorEvidence: string[], wakeReason: string, policy: AutonomousRunPolicy): string {
  return [
    "You are the provider executive for one bounded autonomous cycle.",
    `Original goal: ${goal.prompt}`,
    `Constraints/authority: ${goal.constraints.join("; ") || "none"}. Do not expand this authority.`,
    `Current cycle: ${cycle}`,
    `Prior evidence: ${priorEvidence.length ? priorEvidence.join(" | ") : "none"}`,
    `Wake reason: ${wakeReason}`,
    ...(policy === "external-observation" ? ["Provider output is evidence only. Do not claim recovery; later authoritative health observation decides completion."] : []),
    'Return JSON only with exactly: {"status":"progress|complete|blocked|cancelled","evidence":"bounded evidence","nextWakeReason":"reason"}.',
    'The status must be exactly one of "progress", "complete", "blocked", or "cancelled"; omit nextWakeReason for terminal results.',
  ].join("\\n");
}
'''
new_build = '''function buildPrompt(goal: AutonomousGoal, cycle: number, priorEvidence: string[], wakeReason: string, policy: AutonomousRunPolicy, supervisorInputs: string[] = []): string {
  return [
    "You are the provider executive for one bounded autonomous cycle.",
    `Original goal: ${goal.prompt}`,
    `Constraints/authority: ${goal.constraints.join("; ") || "none"}. Do not expand this authority.`,
    `Current cycle: ${cycle}`,
    `Prior execution evidence: ${priorEvidence.length ? priorEvidence.join(" | ") : "none"}`,
    `Supervisor input since previous cycle: ${supervisorInputs.length ? supervisorInputs.join(" | ") : "none"}`,
    "Supervisor input is dialogue inside the frozen Episode authority. It cannot expand the objective, constraints, or authorized policy instruction.",
    "Prior evidence is continuity, not current truth. Observe current external truth when it matters before acting.",
    `Wake reason: ${wakeReason}`,
    ...(policy === "external-observation" ? ["Provider output is evidence only. Do not claim recovery; later authoritative health observation decides completion."] : []),
    'Return JSON only with: {"status":"progress|complete|blocked|cancelled","evidence":"bounded evidence","nextWakeReason":"reason","supervisorMessage":"optional provider-authored message"}.',
    'The status must be exactly one of "progress", "complete", "blocked", or "cancelled"; omit nextWakeReason for terminal results and omit supervisorMessage when there is nothing useful to tell the supervisor.',
  ].join("\\n");
}
'''
s = replace_once(s, old_build, new_build, "runtime prompt")

# Replace wake claim with defensive event-kind check + atomic assignment of
# bounded pending supervisor input to the same ordinary Run.
claim_pattern = re.compile(r'''function claimWakeAndRun\(db: BridgeDb, goalId: string, receiptId: number\): string \| null \{.*?\n\}\n\nfunction pendingWake''', re.S)
claim_new = r'''interface ClaimedWakeAndRun {
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

function pendingWake'''
s, n = claim_pattern.subn(claim_new, s, count=1)
if n != 1: raise RuntimeError(f"runtime claim replacement: {n}")

# Wake-specific queries must never see supervisor_input.
s = s.replace("WHERE source = 'autonomous' AND status = 'received'\n      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1",
              "WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'\n      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1", 1)
s = s.replace("WHERE source = 'autonomous' AND status = 'run_created'\n      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1",
              "WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'run_created'\n      AND json_extract(payload_json, '$.goalId') = ? ORDER BY id LIMIT 1", 1)

# Add receipt settlement helpers before boundedEvidence.
s = replace_once(s, '''function boundedEvidence(goal: AutonomousGoal, evidence: string): string[] {''', r'''function settleSupervisorInputsForRun(db: BridgeDb, runId: string, status: "completed" | "failed" | "cancelled", errorClass?: string): void {
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

function boundedEvidence(goal: AutonomousGoal, evidence: string): string[] {''', "runtime settle helpers")

# Restart recovery: only wake receipt is recovered; inputs assigned to its Run
# are terminalized with it and later unassigned input is retired.
s = replace_once(s,
'''    db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?")
      .run(goal.cycle + 1, status, JSON.stringify(boundedEvidence(goal, evidence)), goal.goalId);
  });
}''',
'''    db.raw.prepare("UPDATE autonomous_goals SET cycle = ?, status = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ?")
      .run(goal.cycle + 1, status, JSON.stringify(boundedEvidence(goal, evidence)), goal.goalId);
    settleSupervisorInputsForRun(db, receipt.run_id ?? "", status === "cancelled" ? "cancelled" : "failed", "restart_recovery");
    retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
  });
}''', "runtime restart settlement")

# Reconcile assigned input with the same cycle and retire unassigned input only
# once the Episode is terminal.
s = replace_once(s,
'''    if (currentGoal.status !== "active") {
      if (run?.status === "running") db.updateRunCompleted(runId, evidence, null);
      db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      return;
    }''',
'''    if (currentGoal.status !== "active") {
      if (run?.status === "running") db.updateRunCompleted(runId, evidence, null);
      db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "completed");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;
    }''', "runtime reconcile already terminal")
s = replace_once(s,
'''      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      return;''',
'''      db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "cancelled", "goal_cancelled");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;''', "runtime reconcile cancelled")
s = replace_once(s,
'''      db.raw.prepare("UPDATE event_receipts SET status = 'failed', error_class = ?, result_reference = ? WHERE id = ? AND status = 'run_created'").run("malformed_result", runId, receipt.id);
      return;''',
'''      db.raw.prepare("UPDATE event_receipts SET status = 'failed', error_class = ?, result_reference = ? WHERE id = ? AND status = 'run_created'").run("malformed_result", runId, receipt.id);
      settleSupervisorInputsForRun(db, runId, "failed", "malformed_result");
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
      return;''', "runtime reconcile malformed")
s = replace_once(s,
'''    db.updateRunCompleted(runId, result.evidence, null);
    db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);''',
'''    db.updateRunCompleted(runId, result.evidence, null);
    db.raw.prepare("UPDATE event_receipts SET status = 'completed', result_reference = ? WHERE id = ? AND status = 'run_created'").run(runId, receipt.id);
    settleSupervisorInputsForRun(db, runId, "completed");''', "runtime reconcile success")
s = replace_once(s,
'''    if (policy === "provider" && result.status === "progress" && nextStatus === "active") {
      scheduleWake(db, goal.goalId, { key: `${goal.goalId}:wake:${goal.cycle + 1}`, reason: result.nextWakeReason! });
    }
  });''',
'''    if (policy === "provider" && result.status === "progress" && nextStatus === "active") {
      scheduleWake(db, goal.goalId, { key: `${goal.goalId}:wake:${goal.cycle + 1}`, reason: result.nextWakeReason! });
    } else if (nextStatus !== "active") {
      retirePendingSupervisorInputs(db, goal.goalId, "episode_terminal");
    }
  });''', "runtime terminal retire")

# Observer can expose provider-authored supervisor prose, but only when present,
# so existing bounded event shape remains unchanged for cycles without it.
s = replace_once(s,
'''  evidence: string;
}''',
'''  evidence: string;
  supervisorMessage?: string;
}''', "runtime observer type")

# Budget pre-claim retires both wake and any unassigned input.
s = replace_once(s,
'''        db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'budget_exhausted' WHERE id = ? AND status = 'received'").run(currentWake.id);
      });''',
'''        db.raw.prepare("UPDATE event_receipts SET status = 'cancelled', error_class = 'budget_exhausted' WHERE id = ? AND status = 'received' AND event_kind = ?").run(currentWake.id, AUTONOMOUS_EVENT_KIND);
        retirePendingSupervisorInputs(db, goalId, "budget_exhausted");
      });''', "runtime budget")

# Claimed input flows separately into prompt.
s = replace_once(s,
'''    const runId = claimWakeAndRun(db, goalId, currentWake.id);
    if (!runId) return false;
    const eventStore = new EventStore(db, runId);''',
'''    const claim = claimWakeAndRun(db, goalId, currentWake.id);
    if (!claim) return false;
    const { runId, supervisorInputs } = claim;
    const eventStore = new EventStore(db, runId);''', "runtime run claim")
s = replace_once(s,
'''      prompt: buildPrompt(current, current.cycle + 1, current.evidence, JSON.parse(currentWake.payload_json).reason, currentPolicy),''',
'''      prompt: buildPrompt(current, current.cycle + 1, current.evidence, JSON.parse(currentWake.payload_json).reason, currentPolicy, supervisorInputs),''', "runtime prompt invocation")
s = replace_once(s,
'''          evidence: effectiveResult?.evidence ?? error ?? "malformed provider output",
        });''',
'''          evidence: effectiveResult?.evidence ?? error ?? "malformed provider output",
          ...(effectiveResult?.supervisorMessage ? { supervisorMessage: effectiveResult.supervisorMessage } : {}),
        });''', "runtime observer message")

# Health and cancellation terminalization should explicitly include all pending
# autonomous receipts for the goal; unlike wake selection this is intentional.
# Make that intent visible by retiring supervisor input when health budget ends.
s = replace_once(s,
'''    if (goal.cycle >= goal.maxCycles) {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'budget_exhausted', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      return "budget_exhausted";
    }''',
'''    if (goal.cycle >= goal.maxCycles) {
      db.raw.prepare("UPDATE autonomous_goals SET status = 'budget_exhausted', evidence_json = ?, updated_at = CURRENT_TIMESTAMP WHERE goal_id = ? AND status = 'active'")
        .run(JSON.stringify(nextEvidence), goalId);
      retirePendingSupervisorInputs(db, goalId, "budget_exhausted");
      return "budget_exhausted";
    }''', "runtime health budget")

write(path, s)

# ---------------------------------------------------------------------------
# Mechanical first-class controller. Reads AUTONOMY.md at start and freezes it
# into autonomous_goals.prompt; durable route/input state lives in existing KV
# and event_receipts. It does not decide observations or write narrative.
# ---------------------------------------------------------------------------
write("src/autonomyController.ts", r'''import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BotKind } from "./types.js";
import type { BridgeDb } from "./db.js";
import type { BridgeEngine } from "./engine.js";
import {
  cancelAutonomousGoal,
  createAutonomousGoalIfNoneActive,
  drainAutonomousGoal,
  getAutonomousGoal,
  getAutonomousSupervisorState,
  recordAutonomousSupervisorInput,
  recordAutonomousSupervisorMessageId,
  type AutonomousGoal,
  type AutonomousSupervisorRoute,
  type CycleReconciledEvent,
} from "./autonomousGoalRuntime.js";

const MAX_AUTONOMY_FILE_CHARS = 12_000;
const MAX_POLICY_INSTRUCTION_CHARS = 2_000;

export interface AutonomyControllerStartInput {
  bot: BotKind;
  maxCycles?: number;
  initialEvidence?: string[];
  policyInstruction?: string;
  supervisorRoute?: AutonomousSupervisorRoute;
}

export interface AutonomyControllerStatus {
  state: "idle" | "running" | "terminal";
  goal?: AutonomousGoal;
}

export interface AutonomyControllerOptions {
  db: BridgeDb;
  autonomyDir: string;
  maxCycles: number;
  engineForBot: (bot: BotKind) => Pick<BridgeEngine, "executeSurfaceNeutralTurn">;
  deliverSupervisorMessage?: (route: AutonomousSupervisorRoute, text: string) => Promise<number>;
  log?: Pick<Console, "error">;
}

function activeGoals(db: BridgeDb): AutonomousGoal[] {
  const rows = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' ORDER BY created_at DESC, goal_id DESC").all() as Array<{ goal_id: string }>;
  return rows.map((row) => getAutonomousGoal(db, row.goal_id));
}

function latestGoal(db: BridgeDb): AutonomousGoal | null {
  const row = db.raw.prepare("SELECT goal_id FROM autonomous_goals ORDER BY created_at DESC, goal_id DESC LIMIT 1").get() as { goal_id: string } | undefined;
  return row ? getAutonomousGoal(db, row.goal_id) : null;
}

export class AutonomyController {
  readonly workDir: string;
  private readonly draining = new Set<string>();

  constructor(private readonly options: AutonomyControllerOptions) {
    if (!isAbsolute(options.autonomyDir)) throw new Error("AGENT_BRIDGE_AUTONOMY_DIR must be absolute");
    if (!Number.isInteger(options.maxCycles) || options.maxCycles < 1) throw new Error("autonomy maxCycles must be a positive integer");
    this.workDir = join(options.autonomyDir, "work");
    mkdirSync(this.workDir, { recursive: true });
  }

  private frozenPrompt(policyInstruction?: string): string {
    const autonomyPath = join(this.options.autonomyDir, "AUTONOMY.md");
    const authority = readFileSync(autonomyPath, "utf8").trim();
    if (!authority || authority.length > MAX_AUTONOMY_FILE_CHARS) throw new Error("AUTONOMY.md must be non-empty and bounded");
    const policy = policyInstruction?.trim() ?? "";
    if (policy.length > MAX_POLICY_INSTRUCTION_CHARS) throw new Error("autonomy policyInstruction is too long");
    return [
      "[Frozen Episode authority]",
      authority,
      ...(policy ? ["", "[Authorized start policy instruction]", policy] : []),
    ].join("\n");
  }

  async start(input: AutonomyControllerStartInput): Promise<{ goal: AutonomousGoal; created: boolean }> {
    // Do not read or rewrite current policy/route for an already-active Episode.
    // The atomic runtime helper is the final cross-process arbiter.
    const existing = activeGoals(this.options.db);
    if (existing.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous start");
    if (existing.length === 1) {
      this.startDrain(existing[0]);
      return { goal: existing[0], created: false };
    }

    // Resolve the provider before any durable Episode creation. This makes an
    // unavailable provider a clean pre-start failure rather than a stranded goal.
    this.options.engineForBot(input.bot);
    const prompt = this.frozenPrompt(input.policyInstruction);
    const result = createAutonomousGoalIfNoneActive(this.options.db, {
      goalId: `episode-${randomUUID()}`,
      prompt,
      constraints: [],
      bot: input.bot,
      maxCycles: input.maxCycles ?? this.options.maxCycles,
      initialEvidence: input.initialEvidence,
      supervisorRoute: input.supervisorRoute,
    });
    this.startDrain(result.goal);
    return result;
  }

  status(): AutonomyControllerStatus {
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous status");
    if (active.length === 1) return { state: "running", goal: active[0] };
    const latest = latestGoal(this.options.db);
    return latest ? { state: "terminal", goal: latest } : { state: "idle" };
  }

  statusText(): string {
    const status = this.status();
    if (!status.goal) return "Autonomy: idle.";
    return status.state === "running"
      ? `Autonomy: running Episode ${status.goal.goalId}; cycle ${status.goal.cycle}/${status.goal.maxCycles}; provider ${status.goal.bot}.`
      : `Autonomy: ${status.goal.status}; Episode ${status.goal.goalId}; cycles ${status.goal.cycle}/${status.goal.maxCycles}.`;
  }

  async stop(reason = "owner stop"): Promise<AutonomousGoal | null> {
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous stop");
    if (active.length === 0) return latestGoal(this.options.db);
    return cancelAutonomousGoal(this.options.db, active[0].goalId, reason);
  }

  recordSupervisorInput(input: { goalId: string; text: string; idempotencyKey: string }): boolean {
    return recordAutonomousSupervisorInput(this.options.db, input);
  }

  resumeActive(): void {
    const active = activeGoals(this.options.db);
    if (active.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous resume");
    if (active.length === 1) this.startDrain(active[0]);
  }

  private startDrain(goal: AutonomousGoal): void {
    if (goal.status !== "active" || this.draining.has(goal.goalId)) return;
    this.draining.add(goal.goalId);
    const engine = this.options.engineForBot(goal.bot);
    void drainAutonomousGoal(this.options.db, goal.goalId, engine, (event) => this.onCycleReconciled(event))
      .catch((error) => this.options.log?.error?.("[autonomy] drain failed", error))
      .finally(() => this.draining.delete(goal.goalId));
  }

  private onCycleReconciled(event: CycleReconciledEvent): void {
    if (!event.supervisorMessage || !this.options.deliverSupervisorMessage) return;
    const state = getAutonomousSupervisorState(this.options.db, event.goalId);
    if (!state) return;
    void this.options.deliverSupervisorMessage(state.route, event.supervisorMessage)
      .then((messageId) => recordAutonomousSupervisorMessageId(this.options.db, event.goalId, messageId))
      .catch((error) => this.options.log?.error?.("[autonomy] supervisor delivery failed", error));
  }
}
''')

# Telegram adapter is deliberately narrow: parse the temporary owner policy
# command and recognize only replies to message IDs emitted by the same active
# Episode. Everything else falls through to ordinary interactive chat.
write("src/autonomyTelegram.ts", r'''import type { BridgeDb } from "./db.js";
import type { TelegramMessage } from "./types.js";
import { getAutonomousGoal, getAutonomousSupervisorState } from "./autonomousGoalRuntime.js";

export type AutonomyTelegramCommand = "approve" | "status" | "stop";

export function parseAutonomyTelegramCommand(rawText: string, botUsername?: string | null): AutonomyTelegramCommand | null {
  const parts = rawText.trim().split(/\s+/);
  const head = parts[0]?.toLowerCase() ?? "";
  const bare = head === "/autonomy";
  const suffixed = Boolean(botUsername) && head === `/autonomy@${botUsername!.toLowerCase()}`;
  if (!bare && !suffixed) return null;
  const operation = (parts[1] ?? "status").toLowerCase();
  return operation === "approve" || operation === "status" || operation === "stop" ? operation : null;
}

export function matchAutonomousTelegramSupervisorReply(db: BridgeDb, message: TelegramMessage): { goalId: string; text: string; idempotencyKey: string } | null {
  const replyId = message.reply_to_message?.message_id;
  const senderId = message.from?.id;
  const text = (message.text ?? message.caption ?? "").trim();
  if (!replyId || senderId == null || !text) return null;

  const rows = db.raw.prepare("SELECT goal_id FROM autonomous_goals WHERE status = 'active' ORDER BY created_at DESC, goal_id DESC").all() as Array<{ goal_id: string }>;
  if (rows.length > 1) throw new Error("multiple active autonomous Episodes; refusing ambiguous supervisor reply");
  if (rows.length !== 1) return null;
  const goal = getAutonomousGoal(db, rows[0].goal_id);
  if (goal.status !== "active") return null;
  const state = getAutonomousSupervisorState(db, goal.goalId);
  if (!state || state.route.surface !== "telegram") return null;
  if (state.route.address !== String(message.chat.id)) return null;
  if (state.route.identity !== undefined && state.route.identity !== String(senderId)) return null;
  const threadId = message.message_thread_id === undefined ? undefined : String(message.message_thread_id);
  if (state.route.thread !== undefined && state.route.thread !== threadId) return null;
  if (!state.messageIds.includes(replyId)) return null;
  return {
    goalId: goal.goalId,
    text,
    idempotencyKey: `${goal.goalId}:supervisor:telegram:${message.chat.id}:${message.message_id}`,
  };
}
''')

# ---------------------------------------------------------------------------
# BridgeEngine: explicit per-engine cwd and static workspace context. This is
# the isolation seam #466 requires; no process-global cwd/env mutation.
# ---------------------------------------------------------------------------
path = "src/engine.ts"
s = read(path)
s = replace_once(s,
'''  soulContext?: string | null;
  /** Required for built-in /models command on agent bot kinds */''',
'''  soulContext?: string | null;
  /** Optional explicit cwd for this engine instance. Never mutates process.cwd(). */
  workingDir?: string;
  /** Optional frozen/static managed workspace context for this engine instance. */
  workspaceContext?: string | null;
  /** Required for built-in /models command on agent bot kinds */''', "engine options")

# All provider/advisor cwd resolution inside this class becomes instance-aware.
s = re.sub(r'getCliWorkingDir\(([^\n()]+(?:\([^\n()]*\))?[^\n()]*)\)', r'this._workingDir(\1)', s)

# Add helper before run().
s = replace_once(s,
'''  async run(): Promise<void> {''',
'''  private _workingDir(executionKind: BotKind = this._executionKind()): string {
    return this.opts.workingDir ?? getCliWorkingDir(executionKind);
  }

  async run(): Promise<void> {''', "engine cwd helper")

# Static context bypasses process-global workspace lookup for autonomy.
s = replace_once(s,
'''    const workspacePrompt = prependWorkspaceContext(contextPrompt);''',
'''    const workspacePrompt = this.opts.workspaceContext === undefined
      ? prependWorkspaceContext(contextPrompt)
      : (this.opts.workspaceContext ? `[Managed workspace context]\n${this.opts.workspaceContext}\n\n${contextPrompt}` : contextPrompt);''', "engine workspace context")
write(path, s)

# ---------------------------------------------------------------------------
# Telegram type: only the reply metadata needed for correlation.
# ---------------------------------------------------------------------------
path = "src/types.ts"
s = read(path)
message_anchor = '''  message_thread_id?: number;'''
# Insert only in TelegramMessage interface, first occurrence.
s = replace_once(s, message_anchor,
'''  message_thread_id?: number;
  reply_to_message?: {
    message_id: number;
    chat?: { id: number; type?: string };
    from?: { id: number; is_bot?: boolean; username?: string };
    message_thread_id?: number;
  };''', "telegram reply metadata")
write(path, s)

# ---------------------------------------------------------------------------
# Interactive command catalogue: expose /autonomy only when runtime enabled.
# ---------------------------------------------------------------------------
path = "src/interactiveBot.ts"
s = read(path)
s = s.replace('options: { integratedHealth?: boolean } = {}', 'options: { integratedHealth?: boolean; autonomy?: boolean } = {}')
s = replace_once(s,
'''    ...(options.integratedHealth ? [{ command: "health", description: "Run health checks or show the latest report" }] : []),''',
'''    ...(options.integratedHealth ? [{ command: "health", description: "Run health checks or show the latest report" }] : []),
    ...(options.autonomy ? [{ command: "autonomy", description: "Approve, inspect, or stop autonomy" }] : []),''', "interactive autonomy command")
write(path, s)

# ---------------------------------------------------------------------------
# Interactive entrypoint: one existing Telegram poller owns commands, replies,
# transport and provider selection. The autonomy database/working directory is
# optional and explicitly configured; no second poller/service is introduced.
# ---------------------------------------------------------------------------
path = "src/index-interactive.ts"
s = read(path)
s = replace_once(s, 'import dotenv from "dotenv";\n', 'import dotenv from "dotenv";\nimport { isAbsolute, join } from "node:path";\n', "interactive path import")
s = replace_once(s,
'''import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";''',
'''import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";
import { loadWorkspaceContext } from "./workspaceContext.js";
import { AutonomyController } from "./autonomyController.js";
import { matchAutonomousTelegramSupervisorReply, parseAutonomyTelegramCommand } from "./autonomyTelegram.js";
import { AUTONOMOUS_RUN_SURFACE } from "./autonomousGoalRuntime.js";''', "interactive autonomy imports")

s = replace_once(s,
'''const integratedHealth = parseHealthBotMode(process.env) === "integrated";''',
'''const integratedHealth = parseHealthBotMode(process.env) === "integrated";
const autonomyDir = process.env.AGENT_BRIDGE_AUTONOMY_DIR?.trim() || null;
const autonomyDbPath = process.env.AGENT_BRIDGE_AUTONOMY_DB_PATH?.trim() || null;
if (Boolean(autonomyDir) !== Boolean(autonomyDbPath)) throw new Error("AGENT_BRIDGE_AUTONOMY_DIR and AGENT_BRIDGE_AUTONOMY_DB_PATH must be configured together");
if (autonomyDir && !isAbsolute(autonomyDir)) throw new Error("AGENT_BRIDGE_AUTONOMY_DIR must be absolute");
if (autonomyDbPath && !isAbsolute(autonomyDbPath)) throw new Error("AGENT_BRIDGE_AUTONOMY_DB_PATH must be absolute");
const autonomyMaxCycles = Number(process.env.AGENT_BRIDGE_AUTONOMY_MAX_CYCLES || 3);
if (!Number.isInteger(autonomyMaxCycles) || autonomyMaxCycles < 1) throw new Error("AGENT_BRIDGE_AUTONOMY_MAX_CYCLES must be a positive integer");
const autonomyEnabled = Boolean(autonomyDir && autonomyDbPath);''', "interactive autonomy env")

# After normal client, open separate autonomy DB if configured.
s = replace_once(s,
'''const client = new TelegramClient(token, fetch, 45_000);''',
'''const client = new TelegramClient(token, fetch, 45_000);
const autonomyDb = autonomyDbPath ? openProductionDb(autonomyDbPath, {
  serviceId: "telegram:interactive-autonomy",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
}) : null;''', "interactive autonomy db")

# Add autonomy engine/controller after standard engine map is built.
engine_end = ''') as Record<CliKind, BridgeEngine>;

const defaultPref'''
engine_insert = ''') as Record<CliKind, BridgeEngine>;

const autonomyWorkspaceContext = autonomyDir
  ? loadWorkspaceContext({ ...process.env, AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: join(autonomyDir, "CONTEXT.md") })
  : "";
const autonomySoulContext = autonomyDir
  ? loadSoulContext({ mode: "summary", path: join(autonomyDir, "SOUL.md") })
  : null;
const autonomyEngines = autonomyDb && autonomyDir ? Object.fromEntries(
  CLI_KINDS.map((kind) => [kind, new BridgeEngine({
    kind: "autonomous",
    surfaceIdentity: AUTONOMOUS_RUN_SURFACE,
    executionKind: kind as BotKind,
    botConfig: config.bots[kind as BotKind],
    allowedUserIds,
    executionMode: resolveExecutionMode(kind as BotKind, process.env),
    asyncEnabled: true,
    pollIntervalMs,
    soulContext: autonomySoulContext,
    workingDir: join(autonomyDir, "work"),
    workspaceContext: autonomyWorkspaceContext,
  }, autonomyDb, client)]),
) as Record<CliKind, BridgeEngine> : null;
const autonomyController = autonomyDb && autonomyDir && autonomyEngines ? new AutonomyController({
  db: autonomyDb,
  autonomyDir,
  maxCycles: autonomyMaxCycles,
  engineForBot: (bot) => {
    const engine = autonomyEngines[bot as CliKind];
    if (!engine) throw new Error(`provider ${bot} is not available for first-class autonomy`);
    return engine;
  },
  deliverSupervisorMessage: async (route, text) => {
    if (route.surface !== "telegram") throw new Error(`unsupported autonomy supervisor surface: ${route.surface}`);
    const chatId = Number(route.address);
    if (!Number.isSafeInteger(chatId)) throw new Error("invalid Telegram autonomy supervisor chat");
    const thread = route.thread === undefined ? undefined : Number(route.thread);
    if (thread !== undefined && !Number.isSafeInteger(thread)) throw new Error("invalid Telegram autonomy supervisor thread");
    const sent = await client.sendMessage({ chat_id: chatId, text, ...(thread === undefined ? {} : { message_thread_id: thread }) });
    const messageId = sent.result?.message_id;
    if (!Number.isSafeInteger(messageId)) throw new Error("Telegram supervisor message did not return message_id");
    return messageId!;
  },
  log: console,
}) : null;
autonomyController?.resumeActive();

const defaultPref'''
s = replace_once(s, engine_end, engine_insert, "interactive autonomy engines")

# Command registration options.
s = s.replace('{ integratedHealth }', '{ integratedHealth, autonomy: autonomyEnabled }')

# Insert supervisor reply + /autonomy handling before /cli.
command_anchor = '''          if (isCliCommandText(rawText, botUsername)) {'''
command_block = '''          if (autonomyController && autonomyDb) {
            const supervisorReply = matchAutonomousTelegramSupervisorReply(autonomyDb, message);
            if (supervisorReply && autonomyController.recordSupervisorInput(supervisorReply)) {
              continue;
            }
          }

          const autonomyCommand = parseAutonomyTelegramCommand(rawText, botUsername);
          if (autonomyCommand) {
            if (!autonomyController) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "Autonomy is not configured on this runtime.", message_thread_id: message.message_thread_id } });
              continue;
            }
            if (autonomyCommand === "status") {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              continue;
            }
            if (autonomyCommand === "stop") {
              await autonomyController.stop("authenticated owner /autonomy stop");
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              continue;
            }
            const { pref } = resolveCredentialCheckedPreference(chatKey);
            if (!pref) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "No authenticated CLI is available to start autonomy.", message_thread_id: message.message_thread_id } });
              continue;
            }
            const started = await autonomyController.start({
              bot: pref as BotKind,
              policyInstruction: "Authenticated owner approved this Episode via /autonomy approve.",
              supervisorRoute: {
                surface: "telegram",
                address: String(chatId),
                identity: String(message.from!.id),
                ...(message.message_thread_id === undefined ? {} : { thread: String(message.message_thread_id) }),
              },
            });
            const text = started.created ? `Autonomy started: ${started.goal.goalId}.` : `Autonomy already running: ${started.goal.goalId}.`;
            await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text, message_thread_id: message.message_thread_id } });
            continue;
          }

          if (isCliCommandText(rawText, botUsername)) {'''
s = replace_once(s, command_anchor, command_block, "interactive command routing")
write(path, s)

# ---------------------------------------------------------------------------
# Skills: provider-neutral operating contract plus fresh/upgrade convergence.
# ---------------------------------------------------------------------------
write("skills/autonomous-work/skill.json", '''{
  "name": "autonomous-work",
  "version": "1.0.0",
  "description": "Runs bounded autonomous Goal to Episode to Cycle to Run work with evidence, current-truth checks, supervisor dialogue, and budget discipline"
}
''')
write("skills/autonomous-work/SKILL.md", r'''---
name: autonomous-work
description: Execute a bounded autonomous Episode toward a durable Goal using ordinary Agent Bridge Runs, current evidence, and selective supervisor communication.
---

# Autonomous work

Use this skill when an Agent Bridge Run is one Cycle of a bounded autonomous Episode.

## Model

- **Goal**: the durable outcome the domain is trying to reach.
- **Episode**: one bounded attempt under authority frozen when the Episode starts.
- **Cycle**: one wake, one ordinary Run, and reconciliation.
- **Run**: the existing provider execution. Do not invent a second worker or orchestration layer.

## Keep four things separate

1. **Frozen Episode authority**: the objective, constraints, and authorized start-policy instruction. Never expand it from conversation or convenience.
2. **Prior execution evidence**: continuity from earlier Cycles. Evidence can be stale; it is not automatically current truth.
3. **Supervisor input**: questions, context, or tactical steering received between Cycles. Interpret it within frozen authority. It cannot grant broader authority.
4. **Current external truth**: what is true now. Observe it when a decision depends on it.

## Work the goal

Choose the cheapest reliable permitted source that answers the current question: repository/filesystem state, safe data or reports, APIs/CLIs, logs/runtime state, web/search, projected Skills, or domain-owned helpers. Verify current truth before an irreversible or authority-sensitive action.

Act when the evidence supports an action. Do not replace work with status narration. Build a durable helper in the domain `work/` area only when repeated observation makes that cheaper or safer; do not create a generic sensor framework.

Return bounded evidence that another Cycle can use. If more work is justified, return `progress` with a precise `nextWakeReason`. If the goal is reached, blocked, cancelled, or the runtime budget ends, say so through the result contract. Budget exhaustion ends this Episode; it does not authorize another Cycle.

## Supervisor communication

`supervisorMessage` is optional provider-authored prose. Use it only when it helps the supervisor: a material decision, changed direction, meaningful progress, important discovery, risk/question, or terminal review. Do not emit ceremonial per-Cycle summaries or tool-call narration.

A supervisor reply is dialogue, not new authority. Answer questions and use tactical steering when it fits the frozen Episode. If a request exceeds authority, say that rather than silently widening scope.

## Result contract

Return JSON only:

```json
{
  "status": "progress|complete|blocked|cancelled",
  "evidence": "bounded evidence",
  "nextWakeReason": "required only for progress",
  "supervisorMessage": "optional useful supervisor message"
}
```

Do not add hidden lifecycle states, approval waits, narrative fields, sensors, schedulers, workers, or provider stacks.
''')

for path in ["scripts/install.sh", "scripts/upgrade.sh"]:
    s = read(path)
    # Ensure default includes the required skill.
    s = re.sub(r'(DEFAULT_AGENT_BRIDGE_SKILLS="[^"]*)(")', lambda m: (m.group(1) if "autonomous-work" in m.group(1) else m.group(1) + ",autonomous-work") + m.group(2), s, count=1)
    # Custom skill lists still converge the runtime-critical operating contract;
    # explicit none/skip remains an operator opt-out.
    old = '''  if [[ -z "${skills_csv}" || "${skills_csv}" == "none" || "${skills_csv}" == "skip" ]]; then
    return
  fi'''
    new = '''  if [[ -z "${skills_csv}" || "${skills_csv}" == "none" || "${skills_csv}" == "skip" ]]; then
    return
  fi
  if [[ ",${skills_csv}," != *",autonomous-work,"* ]]; then
    skills_csv="${skills_csv},autonomous-work"
  fi'''
    s = replace_once(s, old, new, f"{path} required skill")
    write(path, s)

# Upgrade --update must actually converge skills before tests/restart.
path = "scripts/upgrade.sh"
s = read(path)
s = replace_once(s,
'''  after_agy="$(cli_command_version agy)"
  [[ -z "${after_agy}" ]] || qualify_provider_if_needed agy "${before_agy}" "${after_agy}"

  if (cd "${REPO_DIR}" && npm run | grep -q '^  build$'); then''',
'''  after_agy="$(cli_command_version agy)"
  [[ -z "${after_agy}" ]] || qualify_provider_if_needed agy "${before_agy}" "${after_agy}"

  echo "[update] Converging shared skills..."
  install_shared_skills

  if (cd "${REPO_DIR}" && npm run | grep -q '^  build$'); then''', "upgrade skill convergence")
write(path, s)

# Preserve/emit autonomy config through install defaults.
path = "scripts/install.sh"
s = read(path)
s = replace_once(s,
'''              AGENT_BRIDGE_SOUL_PATH AGENT_BRIDGE_SOUL_MODE \\
               HEALTH_BOT_MODE''',
'''              AGENT_BRIDGE_SOUL_PATH AGENT_BRIDGE_SOUL_MODE \\
              AGENT_BRIDGE_AUTONOMY_DIR AGENT_BRIDGE_AUTONOMY_DB_PATH AGENT_BRIDGE_AUTONOMY_MAX_CYCLES \\
               HEALTH_BOT_MODE''', "install seed autonomy env")
s = replace_once(s,
'''    [[ -n "${AGENT_BRIDGE_SOUL_MODE:-}" ]]  && echo "AGENT_BRIDGE_SOUL_MODE=${AGENT_BRIDGE_SOUL_MODE}"
    echo "HEALTH_MONITOR_ENABLED=${HEALTH_MONITOR_ENABLED:-false}"''',
'''    [[ -n "${AGENT_BRIDGE_SOUL_MODE:-}" ]]  && echo "AGENT_BRIDGE_SOUL_MODE=${AGENT_BRIDGE_SOUL_MODE}"
    [[ -n "${AGENT_BRIDGE_AUTONOMY_DIR:-}" ]] && echo "AGENT_BRIDGE_AUTONOMY_DIR=${AGENT_BRIDGE_AUTONOMY_DIR}"
    [[ -n "${AGENT_BRIDGE_AUTONOMY_DB_PATH:-}" ]] && echo "AGENT_BRIDGE_AUTONOMY_DB_PATH=${AGENT_BRIDGE_AUTONOMY_DB_PATH}"
    [[ -n "${AGENT_BRIDGE_AUTONOMY_MAX_CYCLES:-}" ]] && echo "AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=${AGENT_BRIDGE_AUTONOMY_MAX_CYCLES}"
    echo "HEALTH_MONITOR_ENABLED=${HEALTH_MONITOR_ENABLED:-false}"''', "install defaults autonomy env")
write(path, s)

path = ".env.shared.example"
s = read(path)
s += '''

# Optional first-class autonomous runtime. Both paths must be absolute and set together.
# AUTONOMY.md and other canonical controls live in AGENT_BRIDGE_AUTONOMY_DIR;
# durable runtime-created tools/artifacts live under its work/ child.
AGENT_BRIDGE_AUTONOMY_DIR=
AGENT_BRIDGE_AUTONOMY_DB_PATH=
AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3
'''
write(path, s)

# ---------------------------------------------------------------------------
# Tests: narrow regressions for every risky persistence/transport boundary.
# ---------------------------------------------------------------------------
write("test/autonomyFirstClass.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  AUTONOMOUS_EVENT_KIND,
  AUTONOMOUS_SUPERVISOR_INPUT_KIND,
  createAutonomousGoalIfNoneActive,
  getAutonomousGoal,
  getAutonomousSupervisorState,
  parseAutonomousCycleResult,
  recordAutonomousSupervisorInput,
  recordAutonomousSupervisorMessageId,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";
import { AutonomyController } from "../src/autonomyController.js";
import { matchAutonomousTelegramSupervisorReply, parseAutonomyTelegramCommand } from "../src/autonomyTelegram.js";

function makeDb() {
  const dbPath = join(tmpdir(), `first-class-autonomy-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomy", runId: `process-${Math.random()}` });
  return { db, dbPath };
}
function cleanup(db: ReturnType<typeof openDb>, dbPath: string) { db.close(); try { rmSync(dbPath); } catch {} }
function claudeOutput(value: unknown) { return JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(value), session_id: "session" }); }
function mockEngine(db: ReturnType<typeof openDb>, run: (input: any) => Promise<any>) {
  const engine = new BridgeEngine({
    surfaceIdentity: "autonomous", kind: "autonomous", executionKind: "claude",
    botConfig: { command: "claude", modelPreference: ["default"] }, allowedUserIds: new Set(["1"]),
    executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
  }, db, {
    getUpdates: vi.fn(), sendMessage: vi.fn(), sendChatAction: vi.fn(), setMyCommands: vi.fn(),
    answerCallbackQuery: vi.fn(), editMessageText: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn(),
  } as any, { runCliAsync: vi.fn() });
  vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(run);
  return engine;
}

describe("first-class autonomy (#466)", () => {
  it("atomically creates at most one active Episode and never rebinds its supervisor route", () => {
    const { db, dbPath } = makeDb();
    const first = createAutonomousGoalIfNoneActive(db, {
      goalId: "one", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 3,
      supervisorRoute: { surface: "telegram", address: "10", identity: "20" },
    });
    const second = createAutonomousGoalIfNoneActive(db, {
      goalId: "two", prompt: "different", constraints: [], bot: "codex", maxCycles: 7,
      supervisorRoute: { surface: "telegram", address: "99", identity: "88" },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.goal.goalId).toBe("one");
    expect(getAutonomousSupervisorState(db, "one")?.route).toEqual({ surface: "telegram", address: "10", identity: "20" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals WHERE status = 'active'").get()).toEqual({ count: 1 });
    cleanup(db, dbPath);
  });

  it("never mistakes supervisor_input for a wake and atomically assigns it to the next Run", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "input", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 1 });
    expect(recordAutonomousSupervisorInput(db, { goalId: "input", text: "check the current deployment first", idempotencyKey: "input-1" })).toBe(true);
    const seen: string[] = [];
    const engine = mockEngine(db, async (input) => {
      seen.push(input.prompt);
      return { text: claudeOutput({ status: "complete", evidence: "verified" }) } as any;
    });
    await runNextAutonomousGoal(db, "input", engine);
    expect(seen[0]).toContain("Supervisor input since previous cycle: check the current deployment first");
    expect(seen[0]).toContain("Prior evidence is continuity, not current truth");
    const receipts = db.raw.prepare("SELECT event_kind, status, run_id FROM event_receipts ORDER BY id").all() as any[];
    expect(receipts.find((r) => r.event_kind === AUTONOMOUS_EVENT_KIND)?.status).toBe("completed");
    const supervisor = receipts.find((r) => r.event_kind === AUTONOMOUS_SUPERVISOR_INPUT_KIND);
    expect(supervisor.status).toBe("completed");
    expect(typeof supervisor.run_id).toBe("string");
    expect(getAutonomousGoal(db, "input").status).toBe("complete");
    cleanup(db, dbPath);
  });

  it("keeps unclaimed supervisor input out of wake recovery", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "wake-filter", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 1 });
    db.raw.prepare("UPDATE event_receipts SET status = 'cancelled' WHERE event_kind = ?").run(AUTONOMOUS_EVENT_KIND);
    recordAutonomousSupervisorInput(db, { goalId: "wake-filter", text: "not a wake", idempotencyKey: "input-only" });
    const called = vi.fn();
    expect(await runNextAutonomousGoal(db, "wake-filter", { executeSurfaceNeutralTurn: called } as any)).toBe(false);
    expect(called).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT status FROM event_receipts WHERE event_kind = ?").get(AUTONOMOUS_SUPERVISOR_INPUT_KIND)).toEqual({ status: "received" });
    cleanup(db, dbPath);
  });

  it("accepts bounded provider-authored supervisorMessage and rejects oversized prose", () => {
    expect(parseAutonomousCycleResult(JSON.stringify({ status: "complete", evidence: "done", supervisorMessage: "Material result." }))).toMatchObject({ supervisorMessage: "Material result." });
    expect(() => parseAutonomousCycleResult(JSON.stringify({ status: "complete", evidence: "done", supervisorMessage: "x".repeat(3001) }))).toThrow(/supervisor message/);
  });

  it("matches only an authenticated reply to a message emitted by the same active Episode", () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, {
      goalId: "reply", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 2,
      supervisorRoute: { surface: "telegram", address: "123", identity: "42", thread: "7" },
    });
    recordAutonomousSupervisorMessageId(db, "reply", 900);
    const message: any = { message_id: 901, chat: { id: 123, type: "supergroup" }, from: { id: 42 }, message_thread_id: 7, text: "use option B", reply_to_message: { message_id: 900 } };
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toMatchObject({ goalId: "reply", text: "use option B" });
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, from: { id: 43 } })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, reply_to_message: { message_id: 899 } })).toBeNull();
    db.raw.prepare("UPDATE autonomous_goals SET status = 'complete' WHERE goal_id = 'reply'").run();
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toBeNull();
    cleanup(db, dbPath);
  });

  it("freezes AUTONOMY.md plus start policy, keeps work durable, and does not rewrite an active Episode", async () => {
    const { db, dbPath } = makeDb();
    const dir = mkdtempSync(join(tmpdir(), "autonomy-dir-"));
    writeFileSync(join(dir, "AUTONOMY.md"), "Goal: qualify the current system.\nConstraint: no destructive changes.");
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "work", "learned-tool.txt"), "keep me");
    const neverRun = { executeSurfaceNeutralTurn: vi.fn(async () => new Promise(() => {})) } as any;
    const controller = new AutonomyController({ db, autonomyDir: dir, maxCycles: 20, engineForBot: () => neverRun });
    const first = await controller.start({ bot: "claude", policyInstruction: "Owner approved this Episode.", supervisorRoute: { surface: "telegram", address: "1", identity: "2" } });
    expect(first.created).toBe(true);
    const frozen = getAutonomousGoal(db, first.goal.goalId).prompt;
    expect(frozen).toContain("Goal: qualify the current system.");
    expect(frozen).toContain("Owner approved this Episode.");
    writeFileSync(join(dir, "AUTONOMY.md"), "CHANGED AFTER START");
    const second = await controller.start({ bot: "claude", policyInstruction: "different", supervisorRoute: { surface: "telegram", address: "9" } });
    expect(second.created).toBe(false);
    expect(getAutonomousGoal(db, first.goal.goalId).prompt).toBe(frozen);
    expect(readFileSync(join(dir, "work", "learned-tool.txt"), "utf8")).toBe("keep me");
    await controller.stop("test stop");
    rmSync(dir, { recursive: true, force: true });
    cleanup(db, dbPath);
  });

  it("parses the temporary owner policy command without claiming unrelated chat", () => {
    expect(parseAutonomyTelegramCommand("/autonomy approve")).toBe("approve");
    expect(parseAutonomyTelegramCommand("/autonomy@BridgeBot stop", "BridgeBot")).toBe("stop");
    expect(parseAutonomyTelegramCommand("ordinary text")).toBeNull();
  });
});
'''.replace('import { mkdtempSync, mkdirSync, rmSync, writeFileSync }', 'import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync }'))

write("test/autonomousWorkSkill.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillCatalog } from "../src/skills.js";

describe("autonomous-work skill convergence (#466)", () => {
  it("is provider-neutral and teaches the approved Goal/Episode/Cycle/Run contract", () => {
    const root = process.cwd();
    const catalog = loadSkillCatalog(root);
    expect(catalog.some((skill) => skill.name === "autonomous-work")).toBe(true);
    const text = readFileSync(join(root, "skills", "autonomous-work", "SKILL.md"), "utf8");
    for (const term of ["Goal", "Episode", "Cycle", "Run", "current truth", "supervisorMessage", "frozen authority"]) expect(text).toContain(term);
    expect(text).not.toContain("Farstax");
    expect(text).not.toContain("Company runtime");
  });

  it("converges the required skill on fresh install and --update even with a custom list", () => {
    const install = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const upgrade = readFileSync(join(process.cwd(), "scripts", "upgrade.sh"), "utf8");
    expect(install).toContain("autonomous-work");
    expect(upgrade).toContain("autonomous-work");
    expect(upgrade).toContain("[update] Converging shared skills");
    expect(install).toContain('skills_csv="${skills_csv},autonomous-work"');
    expect(upgrade).toContain('skills_csv="${skills_csv},autonomous-work"');
  });
});
''')

# Test the engine isolation seam directly without exposing new public methods.
write("test/autonomyEngineIsolation.test.ts", r'''import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

describe("autonomous engine isolation (#466)", () => {
  it("uses an explicit per-engine cwd without changing process cwd", () => {
    const dbPath = join(tmpdir(), `autonomy-engine-${Math.random()}.sqlite`);
    const db = openDb(dbPath, { serviceId: "test", runId: "test" });
    const before = process.cwd();
    const engine = new BridgeEngine({
      kind: "autonomous", surfaceIdentity: "autonomous", executionKind: "claude",
      botConfig: { command: "claude", modelPreference: ["default"] }, allowedUserIds: new Set(["1"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
      workingDir: "/tmp/autonomy-work", workspaceContext: "canonical context",
    }, db, { getUpdates: vi.fn(), sendMessage: vi.fn(), sendChatAction: vi.fn() } as any);
    expect((engine as any)._workingDir("claude")).toBe("/tmp/autonomy-work");
    expect(process.cwd()).toBe(before);
    db.close(); try { rmSync(dbPath); } catch {}
  });
});
''')

# Environment example regression is intentionally static: config is optional,
# generic, and defaults to 3 while Farstax remains an external deployment choice.
write("test/autonomyConfig.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("autonomy runtime configuration (#466)", () => {
  it("documents only the generic dir/db/max-cycle settings with default 3", () => {
    const env = readFileSync(".env.shared.example", "utf8");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_DIR=");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_DB_PATH=");
    expect(env).toContain("AGENT_BRIDGE_AUTONOMY_MAX_CYCLES=3");
    expect(env).not.toContain("FARSTAX");
  });
});
''')

print("issue #466 implementation patch applied")
