import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  AUTONOMOUS_EVENT_KIND,
  AUTONOMOUS_EVENT_SOURCE,
  AUTONOMOUS_SUPERVISOR_INPUT_KIND,
  createAutonomousGoal,
  getAutonomousGoal,
  recordAutonomousSupervisorInput,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";

function makeDb() {
  const dbPath = join(tmpdir(), `autonomous-restart-contract-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomous-restart", runId: `process-${Math.random()}` });
  return { db, dbPath };
}

function removeDb(dbPath: string): void {
  try { rmSync(dbPath); } catch {}
}

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function engineReturning(disposition: "continue" | "done", text: string, prompts?: string[]) {
  return {
    executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
      prompts?.push(input.prompt);
      execFileSync(dispositionCommand(input.prompt), [disposition], { stdio: "pipe" });
      return { text };
    }),
  };
}

describe("autonomous restart ownership contract (#366)", () => {
  it("keeps supervisor input as a durable unclaimed receipt and consumes it exactly once in the next Run", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "input-before-claim",
      prompt: "Complete bounded work",
      constraints: [],
      bot: "claude",
      maxCycles: 2,
    });

    await runNextAutonomousGoal(db, "input-before-claim", engineReturning("continue", "cycle one"));
    expect(recordAutonomousSupervisorInput(db, {
      goalId: "input-before-claim",
      text: "owner reply after cycle one",
      idempotencyKey: "owner-message-1",
    })).toBe(true);

    const durableInput = db.raw.prepare(`SELECT status, run_id FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_SUPERVISOR_INPUT_KIND) as any;
    expect(durableInput).toMatchObject({ status: "received", run_id: null });

    const prompts: string[] = [];
    const engine = engineReturning("done", "cycle two", prompts);
    expect(await runNextAutonomousGoal(db, "input-before-claim", engine)).toBe(true);
    expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].split("owner reply after cycle one")).toHaveLength(2);
    expect(getAutonomousGoal(db, "input-before-claim")).toMatchObject({ status: "complete", cycle: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:input-before-claim")).toEqual({ count: 2 });
    expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_SUPERVISOR_INPUT_KIND)).toEqual({ count: 1 });
    expect(db.raw.prepare(`SELECT status FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_SUPERVISOR_INPUT_KIND)).toEqual({ status: "completed" });
    expect(await runNextAutonomousGoal(db, "input-before-claim", engine)).toBe(false);
    expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);

    db.close();
    removeDb(dbPath);
  });

  it("fails a claimed supervisor input with its claimed wake without replay or reconciliation notification", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "input-after-claim",
      prompt: "Complete bounded work",
      constraints: [],
      bot: "claude",
      maxCycles: 3,
    });
    expect(recordAutonomousSupervisorInput(db, {
      goalId: "input-after-claim",
      text: "ambiguous owner reply",
      idempotencyKey: "owner-message-ambiguous",
    })).toBe(true);

    const wake = db.raw.prepare(`SELECT id FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_EVENT_KIND) as { id: number };
    const input = db.raw.prepare(`SELECT id FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_SUPERVISOR_INPUT_KIND) as { id: number };
    const runId = "crashed-autonomous-run-with-input";
    db.insertRun(runId, "autonomous:input-after-claim", "claude");
    db.linkEventReceiptRun(wake.id, runId);
    db.linkEventReceiptRun(input.id, runId);
    expect(db.raw.prepare("SELECT status, run_id FROM event_receipts WHERE id = ?").get(input.id))
      .toEqual({ status: "run_created", run_id: runId });

    const executeSurfaceNeutralTurn = vi.fn();
    const observer = vi.fn();
    expect(await runNextAutonomousGoal(db, "input-after-claim", { executeSurfaceNeutralTurn }, observer)).toBe(true);
    expect(executeSurfaceNeutralTurn).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(getAutonomousGoal(db, "input-after-claim")).toMatchObject({ status: "blocked", cycle: 1 });
    expect(db.raw.prepare("SELECT status, error_class FROM event_receipts WHERE id = ?").get(wake.id))
      .toEqual({ status: "failed", error_class: "restart_recovery" });
    expect(db.raw.prepare("SELECT status, error_class FROM event_receipts WHERE id = ?").get(input.id))
      .toEqual({ status: "failed", error_class: "restart_recovery" });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = ?").get(runId)).toEqual({ status: "failed" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:input-after-claim")).toEqual({ count: 1 });
    expect(db.raw.prepare(`SELECT COUNT(*) AS count FROM event_receipts
      WHERE source = ? AND event_kind = ?`).get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_EVENT_KIND)).toEqual({ count: 1 });
    expect(await runNextAutonomousGoal(db, "input-after-claim", { executeSurfaceNeutralTurn }, observer)).toBe(false);
    expect(executeSurfaceNeutralTurn).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();

    db.close();
    removeDb(dbPath);
  });
});
