import { randomUUID } from "node:crypto";
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
