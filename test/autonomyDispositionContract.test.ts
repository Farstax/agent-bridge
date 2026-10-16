import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import {
  createAutonomousGoal,
  getAutonomousGoal,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";

function makeDb() {
  const dbPath = join(tmpdir(), `autonomy-disposition-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomy-disposition", runId: `process-${Math.random()}` });
  return { db, dbPath };
}

function removeDb(dbPath: string) {
  try { rmSync(dbPath); } catch {}
}

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function engineWithDisposition(
  disposition: "continue" | "done" | "blocked",
  text: string,
  options: { notify?: boolean; failAfterDisposition?: boolean } = {},
) {
  return {
    executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
      execFileSync(dispositionCommand(input.prompt), [
        ...(disposition === "blocked" ? ["blocked", "authority"] : [disposition]),
        ...(options.notify ? ["--notify"] : []),
      ]);
      if (options.failAfterDisposition) throw new Error("provider failed after disposition");
      return { text } as any;
    }),
  } as any;
}

describe("run-scoped autonomous disposition contract", () => {
  it("uses an ordinary final response as evidence and done as lifecycle control", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "done", prompt: "Finish the task", constraints: [], bot: "claude", maxCycles: 3 });
      await runNextAutonomousGoal(db, "done", engineWithDisposition("done", "Implemented and verified the requested change."));

      expect(getAutonomousGoal(db, "done")).toMatchObject({
        status: "complete",
        cycle: 1,
        evidence: ["Implemented and verified the requested change."],
      });
      const run = db.raw.prepare("SELECT status, final_text_preview, error FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as any;
      expect(run).toMatchObject({ status: "done", final_text_preview: "Implemented and verified the requested change.", error: null });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("schedules a generic successor for continue and exhausts the final permitted cycle", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "continue", prompt: "Keep working", constraints: [], bot: "claude", maxCycles: 2 });
      await runNextAutonomousGoal(db, "continue", engineWithDisposition("continue", "First cycle finished."));
      expect(getAutonomousGoal(db, "continue").status).toBe("active");
      const wake = db.raw.prepare("SELECT payload_json FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received' ORDER BY id LIMIT 1").get() as any;
      expect(JSON.parse(wake.payload_json).reason).toBe("provider requested continuation");

      await runNextAutonomousGoal(db, "continue", engineWithDisposition("continue", "Second cycle finished."));
      expect(getAutonomousGoal(db, "continue").status).toBe("budget_exhausted");
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("fails the Run with the specific missing-disposition error and keeps the goal for a fresh recovery cycle", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "missing", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
      const engine = { executeSurfaceNeutralTurn: vi.fn(async () => ({ text: "Work completed, but no disposition was declared." })) } as any;
      await runNextAutonomousGoal(db, "missing", engine);

      expect(getAutonomousGoal(db, "missing")).toMatchObject({ status: "active", cycle: 1 });
      const recoveryWake = db.raw.prepare("SELECT payload_json FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'").get() as any;
      expect(JSON.parse(recoveryWake.payload_json).reason).toContain("recoverable execution failure");
      const run = db.raw.prepare("SELECT status, error FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as any;
      expect(run).toMatchObject({ status: "failed", error: "missing_autonomy_disposition" });
      const receipt = db.raw.prepare("SELECT status, error_class FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' ORDER BY id LIMIT 1").get() as any;
      expect(receipt).toMatchObject({ status: "failed", error_class: "missing_autonomy_disposition" });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("lets provider failure win over a disposition already recorded", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "failure", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
      await runNextAutonomousGoal(db, "failure", engineWithDisposition("done", "unused", { failAfterDisposition: true }));

      expect(getAutonomousGoal(db, "failure")).toMatchObject({ status: "active", cycle: 1 });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'").get()).toEqual({ count: 1 });
      const run = db.raw.prepare("SELECT status, error FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as any;
      expect(run.status).toBe("failed");
      expect(run.error).toContain("provider failed after disposition");
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("keeps a recoverable failure attached to the original goal and escalates only at its retry bound", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "bounded-recovery", prompt: "Repair CI and finish the merge", constraints: [], bot: "claude", maxCycles: 2 });
      const failed = engineWithDisposition("done", "CI failed; repair is required", { failAfterDisposition: true });

      await runNextAutonomousGoal(db, "bounded-recovery", failed);
      const afterFirst = getAutonomousGoal(db, "bounded-recovery");
      expect(afterFirst).toMatchObject({ status: "active", cycle: 1 });
      expect(afterFirst.evidence.at(-1)).toContain("provider failed after disposition");
      const recoveryWake = db.raw.prepare("SELECT payload_json FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'").get() as any;
      expect(JSON.parse(recoveryWake.payload_json).reason).toContain("recoverable execution failure");

      await runNextAutonomousGoal(db, "bounded-recovery", failed);
      expect(getAutonomousGoal(db, "bounded-recovery")).toMatchObject({ status: "budget_exhausted", cycle: 2 });
      expect(failed.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("escalates a missing credential without spending further recovery attempts", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "missing-credential", prompt: "Deploy the qualified release", constraints: [], bot: "claude", maxCycles: 3 });
      const engine = { executeSurfaceNeutralTurn: vi.fn(async () => { throw new Error("missing credential for production deployment"); }) } as any;

      await runNextAutonomousGoal(db, "missing-credential", engine);
      expect(getAutonomousGoal(db, "missing-credential")).toMatchObject({ status: "blocked", cycle: 1 });
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'").get()).toEqual({ count: 0 });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("bounds prior-evidence projection without rejecting a long successful final response", async () => {
    const { db, dbPath } = makeDb();
    try {
      const longText = "x".repeat(12_000);
      createAutonomousGoal(db, { goalId: "long", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
      await runNextAutonomousGoal(db, "long", engineWithDisposition("done", longText));

      const goal = getAutonomousGoal(db, "long");
      expect(goal.status).toBe("complete");
      expect(goal.evidence).toHaveLength(1);
      expect(goal.evidence[0].length).toBeLessThanOrEqual(2_000);
      const run = db.raw.prepare("SELECT final_text_preview FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as any;
      expect(run.final_text_preview).toBe(longText);
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("projects --notify only after a successful reconciliation", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "notify", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
      const events: any[] = [];
      await runNextAutonomousGoal(db, "notify", engineWithDisposition("done", "Owner-facing final response.", { notify: true }), (event) => events.push(event));
      expect(events).toEqual([expect.objectContaining({
        disposition: "done",
        evidence: "Owner-facing final response.",
        notify: true,
      })]);
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });
});
