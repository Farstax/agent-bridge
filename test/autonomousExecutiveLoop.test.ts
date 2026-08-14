import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  AutonomousGoalCoordinator,
  InMemoryAutonomousGoalStore,
  type AutonomousGoal,
  type AutonomousGoalStore,
  type AutonomousRun,
  type AutonomousWake,
  type AutonomousCycleStatus,
  type AutonomousCycleResult,
} from "../src/autonomousExecutiveLoop.js";
import { RunRepository } from "../src/repositories/runRepository.js";

/** Test-only durable adapter. It is reopened from SQLite to prove restart. */
class SqliteAutonomousGoalStore implements AutonomousGoalStore {
  private readonly runs: RunRepository;

  constructor(private readonly db: ReturnType<typeof openDb>) {
    this.runs = new RunRepository(db.raw);
    db.raw.exec(`
      CREATE TABLE IF NOT EXISTS autonomous_spike_goals (
        goal_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, constraints_json TEXT NOT NULL,
        status TEXT NOT NULL, cycle INTEGER NOT NULL DEFAULT 0, evidence_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS autonomous_spike_wakes (
        wake_key TEXT PRIMARY KEY, goal_id TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL, run_id TEXT, cycle INTEGER,
        FOREIGN KEY(goal_id) REFERENCES autonomous_spike_goals(goal_id),
        FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
      );
      CREATE INDEX IF NOT EXISTS idx_autonomous_spike_wakes_pending
        ON autonomous_spike_wakes(goal_id, status, wake_key);
    `);
  }

  createGoal(input: Pick<AutonomousGoal, "goalId" | "prompt" | "constraints">): void {
    this.db.raw.prepare(`INSERT INTO autonomous_spike_goals (goal_id, prompt, constraints_json, status) VALUES (?, ?, ?, 'active')`)
      .run(input.goalId, input.prompt, JSON.stringify(input.constraints));
  }

  getGoal(goalId: string): AutonomousGoal {
    const row = this.db.raw.prepare(`SELECT * FROM autonomous_spike_goals WHERE goal_id = ?`).get(goalId) as any;
    if (!row) throw new Error(`unknown goal: ${goalId}`);
    return { goalId: row.goal_id, prompt: row.prompt, constraints: JSON.parse(row.constraints_json), status: row.status, cycle: row.cycle, evidence: JSON.parse(row.evidence_json) };
  }

  scheduleWake(goalId: string, input: { key: string; reason: string }): boolean {
    if (this.getGoal(goalId).status !== "active") return false;
    try {
      this.db.raw.prepare(`INSERT INTO autonomous_spike_wakes (wake_key, goal_id, reason, status) VALUES (?, ?, ?, 'pending')`).run(input.key, goalId, input.reason);
      return true;
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return false;
      throw error;
    }
  }

  nextWake(goalId: string): AutonomousWake | null {
    const row = this.db.raw.prepare(`SELECT wake_key, goal_id, reason, status, run_id, cycle FROM autonomous_spike_wakes WHERE goal_id = ? AND status = 'pending' ORDER BY wake_key LIMIT 1`).get(goalId) as any;
    return row ? { key: row.wake_key, goalId: row.goal_id, reason: row.reason, status: row.status, runId: row.run_id, cycle: row.cycle } : null;
  }

  ensureRun(wakeKey: string, runId: string, cycle: number): AutonomousRun {
    return this.db.raw.transaction(() => {
      const wake = this.db.raw.prepare(`SELECT * FROM autonomous_spike_wakes WHERE wake_key = ?`).get(wakeKey) as any;
      if (!wake) throw new Error(`unknown wake: ${wakeKey}`);
      if (wake.run_id) return { runId: wake.run_id, goalId: wake.goal_id, wakeKey, cycle, status: this.db.getRun(wake.run_id).status };
      this.runs.insertRun(runId, `autonomous:${wake.goal_id}`, "claude");
      this.db.raw.prepare(`UPDATE autonomous_spike_wakes SET status = 'run_created', run_id = ?, cycle = ? WHERE wake_key = ? AND status = 'pending'`).run(runId, cycle, wakeKey);
      return { runId, goalId: wake.goal_id, wakeKey, cycle, status: "running" as const };
    })();
  }

  completeCycle(wakeKey: string, result: AutonomousCycleResult, nextWake: { key: string; reason: string } | null, nextStatus: AutonomousGoal["status"]): void {
    this.db.raw.transaction(() => {
      const wake = this.db.raw.prepare(`SELECT * FROM autonomous_spike_wakes WHERE wake_key = ?`).get(wakeKey) as any;
      if (!wake?.run_id || wake.status === "completed") return;
      if (result.status === "cancelled") this.runs.updateRunCancelled(wake.run_id, result.evidence);
      else if (result.status === "blocked") this.runs.updateRunFailed(wake.run_id, result.evidence);
      else this.runs.updateRunCompleted(wake.run_id, result.evidence, null);
      const goal = this.getGoal(wake.goal_id);
      this.db.raw.prepare(`UPDATE autonomous_spike_wakes SET status = 'completed' WHERE wake_key = ?`).run(wakeKey);
      this.db.raw.prepare(`UPDATE autonomous_spike_goals SET status = ?, cycle = ?, evidence_json = ? WHERE goal_id = ?`).run(nextStatus, wake.cycle, JSON.stringify([...goal.evidence, result.evidence]), wake.goal_id);
      if (nextWake && nextStatus === "active") this.scheduleWake(wake.goal_id, nextWake);
    })();
  }
}

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
