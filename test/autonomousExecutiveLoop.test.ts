import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  AutonomousGoalCoordinator,
  InMemoryAutonomousGoalStore,
  SqliteAutonomousGoalStore,
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
    const dbPath = join(tmpdir(), `autonomous-goal-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath, { serviceId: "test-autonomous", runId: "test-process" });
    const store = new SqliteAutonomousGoalStore(db);
    const first = new AutonomousGoalCoordinator(store, { runId: (cycle) => `run-${cycle}` });
    store.createGoal({ goalId: "goal-2", prompt: "Make progress", constraints: [] });
    expect(store.scheduleWake("goal-2", { key: "goal-2:wake:0", reason: "initial" })).toBe(true);
    expect(store.scheduleWake("goal-2", { key: "goal-2:wake:0", reason: "duplicate" })).toBe(false);

    await first.runNext("goal-2", async () => ({
      status: "progress",
      evidence: "first result",
      nextWakeReason: "restart-safe successor",
    }));

    db.close();
    const reopened = openDb(dbPath, { serviceId: "test-autonomous", runId: "test-process-restarted" });
    const restarted = new AutonomousGoalCoordinator(new SqliteAutonomousGoalStore(reopened), { runId: (cycle) => `run-${cycle}` });
    await restarted.runNext("goal-2", async () => ({ status: "complete", evidence: "second result" }));

    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:goal-2")).toEqual({ count: 2 });
    expect(reopened.raw.prepare("SELECT status FROM autonomous_spike_goals WHERE goal_id = ?").get("goal-2")).toEqual({ status: "complete" });
    expect(reopened.raw.prepare("SELECT wake_key FROM autonomous_spike_wakes WHERE goal_id = ? ORDER BY wake_key").all("goal-2")).toEqual([
      { wake_key: "goal-2:wake:0" },
      { wake_key: "goal-2:wake:1" },
    ]);
    expect(reopened.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ? ORDER BY started_at").all("autonomous:goal-2")).toEqual([
      { status: "done" },
      { status: "done" },
    ]);
    reopened.close();
    rmSync(dbPath, { force: true });
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
