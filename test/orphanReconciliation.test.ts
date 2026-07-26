import { afterEach, describe, expect, it } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const CUTOFF_MS = 10 * 60 * 1000;

describe("orphaned run reconciliation", () => {
  let db: BridgeDb | undefined;

  afterEach(() => db?.close());

  function open(): BridgeDb {
    db = openDb(":memory:");
    return db;
  }

  function insertRunning(bridge: BridgeDb, runId: string, startedAt: string): void {
    bridge.insertRun(runId, "chat-1", "codex");
    bridge.raw.prepare("UPDATE bridge_runs SET started_at = ? WHERE run_id = ?").run(startedAt, runId);
  }

  it("fails only a stale run proven inactive and records an audit event", async () => {
    const bridge = open();
    insertRunning(bridge, "stale", "2026-07-22T11:00:00.000Z");
    const queued = bridge.createWorkJob({ task_type: "ops_check", idempotency_key: "queue-1" });
    bridge.enqueueMsg("telegram:interactive", "chat-1", { prompt: "queued prompt", chatId: 1, chatType: "private" });
    const pendingBefore = bridge.dequeueMsgs("telegram:interactive", "chat-1");
    const notified: string[] = [];

    const reconciled = await bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: CUTOFF_MS,
      processState: () => "absent",
      containmentState: () => "proven",
      onReconciled: async (run) => { notified.push(run.run_id); },
    });

    expect(reconciled.map((run) => run.run_id)).toEqual(["stale"]);
    expect(notified).toEqual(["stale"]);
    expect(bridge.getRun("stale")).toMatchObject({
      status: "failed",
      error: "Process interrupted by bridge restart",
    });
    expect(bridge.getEventsForRun("stale")).toEqual([
      expect.objectContaining({ type: "reconciliation.started", seq: 1 }),
      expect.objectContaining({ type: "run.reconciled", seq: 2 }),
      expect.objectContaining({ type: "reconciliation.completed", seq: 3 }),
    ]);
    expect(JSON.parse(bridge.getEventsForRun("stale")[0].payload_json)).toMatchObject({
      reason: "stale_after_cutoff",
      processState: "absent",
      lockState: "absent",
    });
    expect(bridge.getWorkJob(queued.id)).toMatchObject({ status: "pending", idempotency_key: "queue-1" });
    expect(bridge.dequeueMsgs("telegram:interactive", "chat-1")).toEqual(pendingBefore);
  });

  it("leaves recent, locked, live, and ambiguous runs unchanged", async () => {
    const bridge = open();
    insertRunning(bridge, "recent", "2026-07-22T11:55:00.000Z");
    insertRunning(bridge, "locked", "2026-07-22T11:00:00.000Z");
    insertRunning(bridge, "live", "2026-07-22T11:00:00.000Z");
    insertRunning(bridge, "ambiguous", "2026-07-22T11:00:00.000Z");
    const lock = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lock).not.toBeNull();
    bridge.raw.prepare("UPDATE execution_locks SET run_id = ? WHERE surface = ? AND chat_key = ?")
      .run("locked", "telegram:interactive", "chat-1");

    const reconciled = await bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: CUTOFF_MS,
      processState: (run) => run.run_id === "live" ? "live" : run.run_id === "ambiguous" ? "ambiguous" : "absent",
      containmentState: (_run, state) => state === "absent" ? "proven" : "ambiguous",
    });

    expect(reconciled).toEqual([]);
    for (const runId of ["recent", "locked", "live", "ambiguous"]) {
      expect(bridge.getRun(runId).status).toBe("running");
    }
  });

  it("is idempotent and cannot reconcile a run twice", async () => {
    const bridge = open();
    insertRunning(bridge, "once", "2026-07-22T11:00:00.000Z");
    const options = {
      nowMs: NOW,
      minAgeMs: CUTOFF_MS,
      processState: () => "absent" as const,
      containmentState: () => "proven" as const,
    };

    expect((await bridge.reconcileOrphanedRuns(options)).map((run) => run.run_id)).toEqual(["once"]);
    expect(await bridge.reconcileOrphanedRuns(options)).toEqual([]);
    expect(bridge.getEventsForRun("once")).toHaveLength(3);
  });
});
