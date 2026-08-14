/**
 * Issue #389 spike harness.
 *
 * This module models the durable boundary only. It deliberately does not
 * schedule work, spawn provider-native agents, or create a second execution
 * runtime. A production adapter can map the store and executor to the existing
 * bridge_runs/event-receipts/executeSurfaceNeutralTurn path after the spike
 * proves the boundary.
 */

export type AutonomousGoalStatus = "active" | "complete" | "blocked" | "cancelled" | "budget_exhausted";
export type AutonomousCycleStatus = "progress" | "complete" | "blocked" | "cancelled";

export interface AutonomousGoal {
  goalId: string;
  prompt: string;
  constraints: string[];
  status: AutonomousGoalStatus;
  cycle: number;
  evidence: string[];
}

export interface AutonomousWake {
  key: string;
  goalId: string;
  reason: string;
  status: "pending" | "run_created" | "completed";
  runId: string | null;
  cycle: number | null;
}

export interface AutonomousRun {
  runId: string;
  goalId: string;
  wakeKey: string;
  cycle: number;
  status: "running" | "done" | "failed";
}

export interface AutonomousCycleResult {
  status: AutonomousCycleStatus;
  evidence: string;
  nextWakeReason?: string;
}

export interface AutonomousCycleInput {
  goal: AutonomousGoal;
  cycle: number;
  runId: string;
  wakeKey: string;
}

export interface AutonomousGoalStore {
  createGoal(input: Pick<AutonomousGoal, "goalId" | "prompt" | "constraints">): void;
  getGoal(goalId: string): AutonomousGoal;
  scheduleWake(goalId: string, input: { key: string; reason: string }): boolean;
  nextWake(goalId: string): AutonomousWake | null;
  ensureRun(wakeKey: string, runId: string, cycle: number): AutonomousRun;
  completeCycle(wakeKey: string, result: AutonomousCycleResult, nextWake: { key: string; reason: string } | null, nextStatus: AutonomousGoalStatus): void;
}

export class InMemoryAutonomousGoalStore implements AutonomousGoalStore {
  private readonly goals = new Map<string, AutonomousGoal>();
  private readonly wakes = new Map<string, AutonomousWake>();
  private readonly runs = new Map<string, AutonomousRun>();

  createGoal(input: Pick<AutonomousGoal, "goalId" | "prompt" | "constraints">): void {
    if (this.goals.has(input.goalId)) throw new Error(`goal already exists: ${input.goalId}`);
    this.goals.set(input.goalId, { ...input, constraints: [...input.constraints], status: "active", cycle: 0, evidence: [] });
  }

  getGoal(goalId: string): AutonomousGoal {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`unknown goal: ${goalId}`);
    return { ...goal, constraints: [...goal.constraints], evidence: [...goal.evidence] };
  }

  scheduleWake(goalId: string, input: { key: string; reason: string }): boolean {
    const goal = this.getGoal(goalId);
    if (goal.status !== "active") return false;
    if (this.wakes.has(input.key)) return false;
    this.wakes.set(input.key, { key: input.key, goalId, reason: input.reason, status: "pending", runId: null, cycle: null });
    return true;
  }

  nextWake(goalId: string): AutonomousWake | null {
    const wake = [...this.wakes.values()]
      .filter((candidate) => candidate.goalId === goalId && candidate.status === "pending")
      .sort((a, b) => a.key.localeCompare(b.key))[0];
    return wake ? { ...wake } : null;
  }

  ensureRun(wakeKey: string, runId: string, cycle: number): AutonomousRun {
    const wake = this.wakes.get(wakeKey);
    if (!wake) throw new Error(`unknown wake: ${wakeKey}`);
    if (wake.runId) return { ...this.runs.get(wake.runId)! };
    wake.status = "run_created";
    wake.runId = runId;
    wake.cycle = cycle;
    const run: AutonomousRun = { runId, goalId: wake.goalId, wakeKey, cycle, status: "running" };
    this.runs.set(runId, run);
    return { ...run };
  }

  completeCycle(wakeKey: string, result: AutonomousCycleResult, nextWake: { key: string; reason: string } | null, nextStatus: AutonomousGoalStatus): void {
    const wake = this.wakes.get(wakeKey);
    if (!wake?.runId || wake.status === "completed") return;
    const run = this.runs.get(wake.runId);
    if (!run) throw new Error(`run missing for wake: ${wakeKey}`);
    run.status = result.status === "cancelled" || result.status === "blocked" ? "failed" : "done";
    wake.status = "completed";
    const goal = this.goals.get(wake.goalId)!;
    goal.cycle = wake.cycle!;
    goal.evidence.push(result.evidence);
    goal.status = nextStatus;
    if (nextWake && nextStatus === "active") {
      this.scheduleWake(goal.goalId, nextWake);
    }
  }

  listRuns(goalId: string): AutonomousRun[] {
    return [...this.runs.values()].filter((run) => run.goalId === goalId).map((run) => ({ ...run }));
  }

  listWakeKeys(goalId: string): string[] {
    return [...this.wakes.values()].filter((wake) => wake.goalId === goalId).map((wake) => wake.key).sort();
  }
}

export class AutonomousGoalCoordinator {
  private readonly maxCycles: number;
  private readonly runId: (cycle: number) => string;

  constructor(private readonly store: AutonomousGoalStore, options: { maxCycles?: number; runId?: (cycle: number) => string } = {}) {
    this.maxCycles = options.maxCycles ?? 3;
    if (!Number.isInteger(this.maxCycles) || this.maxCycles < 1) throw new Error("maxCycles must be a positive integer");
    this.runId = options.runId ?? ((cycle) => `autonomous-run-${cycle}`);
  }

  async runNext(goalId: string, execute: (input: AutonomousCycleInput) => Promise<AutonomousCycleResult>): Promise<AutonomousRun | null> {
    const goal = this.store.getGoal(goalId);
    if (goal.status !== "active") return null;
    const wake = this.store.nextWake(goalId);
    if (!wake) return null;
    const cycle = goal.cycle + 1;
    const run = this.store.ensureRun(wake.key, this.runId(cycle), cycle);
    const result = await execute({ goal: this.store.getGoal(goalId), cycle, runId: run.runId, wakeKey: wake.key });
    const terminal = result.status !== "progress";
    const nextStatus: AutonomousGoalStatus = result.status === "complete"
      ? "complete"
      : result.status === "blocked"
        ? "blocked"
        : result.status === "cancelled"
          ? "cancelled"
          : cycle >= this.maxCycles ? "budget_exhausted" : "active";
    const nextWake = !terminal && cycle < this.maxCycles
      ? { key: `${goalId}:wake:${cycle}`, reason: result.nextWakeReason ?? "continue" }
      : null;
    this.store.completeCycle(wake.key, result, nextWake, nextStatus);
    return run;
  }
}
