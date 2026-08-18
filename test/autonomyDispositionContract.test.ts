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
        disposition,
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

  it("fails closed with the specific missing-disposition error after a successful provider response", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "missing", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
      const engine = { executeSurfaceNeutralTurn: vi.fn(async () => ({ text: "Work completed, but no disposition was declared." })) } as any;
      await runNextAutonomousGoal(db, "missing", engine);

      expect(getAutonomousGoal(db, "missing").status).toBe("blocked");
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

      expect(getAutonomousGoal(db, "failure").status).toBe("blocked");
      const run = db.raw.prepare("SELECT status, error FROM bridge_runs ORDER BY started_at DESC LIMIT 1").get() as any;
      expect(run.status).toBe("failed");
      expect(run.error).toContain("provider failed after disposition");
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

  it("keeps external-observation goals active when the provider declares done", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, {
        goalId: "external-done",
        prompt: "Investigate health",
        constraints: ["autonomous-policy:external-health-observation"],
        bot: "claude",
        maxCycles: 3,
      });
      await runNextAutonomousGoal(db, "external-done", engineWithDisposition("done", "Repair applied; awaiting health observation."));
      expect(getAutonomousGoal(db, "external-done").status).toBe("active");
      const pending = db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'goal_wake' AND status = 'received'").get() as any;
      expect(pending.count).toBe(0);
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
