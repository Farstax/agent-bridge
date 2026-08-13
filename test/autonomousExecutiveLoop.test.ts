import { describe, expect, it } from "vitest";
import {
  AutonomousGoalCoordinator,
  InMemoryAutonomousGoalStore,
  type AutonomousCycleResult,
} from "../src/autonomousExecutiveLoop.js";

describe("autonomous executive loop spike", () => {
  it("runs three bounded cycles from one goal without another user instruction", async () => {
    const store = new InMemoryAutonomousGoalStore();
    const coordinator = new AutonomousGoalCoordinator(store, {
      maxCycles: 3,
      runId: (cycle) => `run-${cycle}`,
    });
    store.createGoal({
      goalId: "goal-1",
      prompt: "Reach the target",
      constraints: ["stay within the test workspace"],
    });
    store.scheduleWake("goal-1", { key: "goal-1:wake:0", reason: "initial" });

    const seenCycles: number[] = [];
    const execute = async (input: { cycle: number }): Promise<AutonomousCycleResult> => {
      seenCycles.push(input.cycle);
      return input.cycle < 3
        ? { status: "progress", evidence: `cycle-${input.cycle}`, nextWakeReason: "continue" }
        : { status: "complete", evidence: "target reached" };
    };

    await coordinator.runNext("goal-1", execute);
    await coordinator.runNext("goal-1", execute);
    await coordinator.runNext("goal-1", execute);

    expect(seenCycles).toEqual([1, 2, 3]);
    expect(store.listRuns("goal-1").map((run) => run.runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect(store.getGoal("goal-1").status).toBe("complete");
    expect(store.getGoal("goal-1").evidence).toEqual(["cycle-1", "cycle-2", "target reached"]);
  });

  it("deduplicates a wake and preserves successor intent across coordinator restart", async () => {
    const store = new InMemoryAutonomousGoalStore();
    const first = new AutonomousGoalCoordinator(store, { runId: (cycle) => `run-${cycle}` });
    store.createGoal({ goalId: "goal-2", prompt: "Make progress", constraints: [] });
    expect(store.scheduleWake("goal-2", { key: "goal-2:wake:0", reason: "initial" })).toBe(true);
    expect(store.scheduleWake("goal-2", { key: "goal-2:wake:0", reason: "duplicate" })).toBe(false);

    await first.runNext("goal-2", async () => ({
      status: "progress",
      evidence: "first result",
      nextWakeReason: "restart-safe successor",
    }));

    const restarted = new AutonomousGoalCoordinator(store, { runId: (cycle) => `run-${cycle}` });
    await restarted.runNext("goal-2", async () => ({ status: "complete", evidence: "second result" }));

    expect(store.listRuns("goal-2")).toHaveLength(2);
    expect(store.getGoal("goal-2").status).toBe("complete");
    expect(store.listWakeKeys("goal-2")).toEqual(["goal-2:wake:0", "goal-2:wake:1"]);
  });

  it("stops at the cycle bound and records a mechanical budget outcome", async () => {
    const store = new InMemoryAutonomousGoalStore();
    const coordinator = new AutonomousGoalCoordinator(store, { maxCycles: 2, runId: (cycle) => `run-${cycle}` });
    store.createGoal({ goalId: "goal-3", prompt: "Keep working", constraints: [] });
    store.scheduleWake("goal-3", { key: "goal-3:wake:0", reason: "initial" });

    const execute = async () => ({ status: "progress" as const, evidence: "still working", nextWakeReason: "continue" });
    await coordinator.runNext("goal-3", execute);
    await coordinator.runNext("goal-3", execute);

    expect(store.getGoal("goal-3").status).toBe("budget_exhausted");
    expect(store.listRuns("goal-3")).toHaveLength(2);
  });
});
