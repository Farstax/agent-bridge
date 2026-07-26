import { afterEach, describe, expect, it } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

describe("recovery-readiness reconciliation guards", () => {
  let db: BridgeDb | undefined;
  afterEach(() => db?.close());

  function open(): BridgeDb {
    db = openDb(":memory:");
    return db;
  }

  function staleRun(bridge: BridgeDb, runId: string): void {
    bridge.insertRun(runId, "chat-1", "codex");
    bridge.raw.prepare("UPDATE bridge_runs SET started_at = ? WHERE run_id = ?")
      .run("2026-07-26T10:00:00.000Z", runId);
  }

  it("fails closed without proven containment and preserves queued and claimed rows", async () => {
    const bridge = open();
    staleRun(bridge, "ambiguous-run");
    bridge.enqueueMsg("telegram:interactive", "chat-1", { prompt: "pending", chatId: 1, chatType: "private" });
    const lock = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lock).not.toBeNull();
    bridge.raw.prepare(
      "UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?"
    ).run("ambiguous-run", lock!.acquisitionId);

    const before = bridge.raw.prepare(
      "SELECT id, state, claim_run_id, claim_acquisition_id FROM pending_messages ORDER BY id"
    ).all();
    expect(await bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: 60_000,
      processState: () => "absent",
    })).toEqual([]);

    expect(bridge.getRun("ambiguous-run").status).toBe("running");
    expect(bridge.raw.prepare(
      "SELECT id, state, claim_run_id, claim_acquisition_id FROM pending_messages ORDER BY id"
    ).all()).toEqual(before);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM execution_locks").get()).toEqual({ n: 1 });
  });

  it("reconciles only with explicit containment, no lock, and no claim, idempotently", async () => {
    const bridge = open();
    staleRun(bridge, "stale-run");
    const options = {
      nowMs: NOW,
      minAgeMs: 60_000,
      processState: () => "absent" as const,
      containmentState: () => "proven" as const,
    };

    expect((await bridge.reconcileOrphanedRuns(options)).map((run) => run.run_id)).toEqual(["stale-run"]);
    expect(await bridge.reconcileOrphanedRuns(options)).toEqual([]);
    expect(bridge.getRun("stale-run").status).toBe("failed");
    const events = bridge.getEventsForRun("stale-run");
    expect(events.map((event) => event.type)).toEqual([
      "reconciliation.started", "run.reconciled", "reconciliation.completed",
    ]);
    expect(JSON.parse(events[2].payload_json)).toMatchObject({
      before: { status: "running", processState: "absent", lockState: "absent" },
      after: { status: "failed" },
      reason: "stale_after_cutoff",
    });
  });

  it("releases only explicitly stale locks and records before/after evidence", () => {
    const bridge = open();
    const lock = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lock).not.toBeNull();
    expect(bridge.reconcileStaleExecutionLocks({
      nowMs: NOW,
      containmentState: () => "ambiguous",
      lockState: () => "stale",
      reason: "offline-recovery-test",
    })).toEqual([]);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM execution_locks").get()).toEqual({ n: 1 });

    expect(bridge.reconcileStaleExecutionLocks({
      nowMs: NOW,
      containmentState: () => "proven",
      lockState: () => "stale",
      reason: "offline-recovery-test",
    })).toEqual([expect.objectContaining({ run_id: lock!.runId, acquisition_id: lock!.acquisitionId })]);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM execution_locks").get()).toEqual({ n: 0 });
  });

  it("does not release a stale-classified lock while its acquisition still owns a claim", () => {
    const bridge = open();
    const lock = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lock).not.toBeNull();
    bridge.enqueueMsg("telegram:interactive", "chat-1", { prompt: "claimed", chatId: 1, chatType: "private" });
    bridge.raw.prepare(`UPDATE pending_messages
      SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?`)
      .run(lock!.runId, lock!.acquisitionId);

    expect(bridge.reconcileStaleExecutionLocks({
      containmentState: () => "proven",
      lockState: () => "stale",
      reason: "claimed-work-boundary",
    })).toEqual([]);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM execution_locks").get()).toEqual({ n: 1 });
  });

  it("only exposes reconciliation_audit through the migration-owned schema", () => {
    const bridge = open();
    expect(Number(bridge.raw.pragma("user_version", { simple: true }))).toBe(4);
    expect(bridge.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reconciliation_audit'"
    ).get()).toBeTruthy();
  });

  it("does not replay or rewrite claimed work when reconciliation is repeated", async () => {
    const bridge = open();
    staleRun(bridge, "claimed-run");
    bridge.enqueueMsg("telegram:interactive", "chat-1", { prompt: "claimed", chatId: 1, chatType: "private" });
    bridge.raw.prepare(
      "UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?"
    ).run("claimed-run", "acquisition-claimed");
    const before = bridge.raw.prepare("SELECT * FROM pending_messages").all();
    expect(await bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: 60_000,
      processState: () => "absent",
      containmentState: () => "proven",
    })).toEqual([]);
    expect(bridge.raw.prepare("SELECT * FROM pending_messages").all()).toEqual(before);
  });

  it("blocks a stale run when another run owns the same chat lock", async () => {
    const bridge = open();
    staleRun(bridge, "run-a");
    const lock = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lock).not.toBeNull();
    bridge.raw.prepare("UPDATE execution_locks SET run_id = ? WHERE chat_key = ?").run("run-b", "chat-1");
    expect(await bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: 60_000,
      processState: () => "absent",
      containmentState: () => "proven",
    })).toEqual([]);
    expect(bridge.getRun("run-a").status).toBe("running");
  });

  it("rolls back all reconciliation writes if interrupted", async () => {
    const bridge = open();
    staleRun(bridge, "interrupted");
    await expect(bridge.reconcileOrphanedRuns({
      nowMs: NOW,
      minAgeMs: 60_000,
      processState: () => "absent",
      containmentState: () => "proven",
      beforeMutation: () => { throw new Error("injected interruption"); },
    })).rejects.toThrow("injected interruption");
    expect(bridge.getRun("interrupted").status).toBe("running");
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM reconciliation_audit").get()).toEqual({ n: 0 });
  });
});
