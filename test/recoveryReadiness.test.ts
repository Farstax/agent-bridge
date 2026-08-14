import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("preserves locks and claims for every mismatched lane/run/acquisition correlation", () => {
    const bridge = open();
    const lockA = bridge.acquireLock("telegram:interactive", "chat-a");
    const lockB = bridge.acquireLock("telegram:interactive", "chat-b");
    expect(lockA).not.toBeNull();
    expect(lockB).not.toBeNull();
    bridge.enqueueMsg("telegram:interactive", "chat-a", { prompt: "a", chatId: 1, chatType: "private" });
    bridge.enqueueMsg("telegram:interactive", "chat-b", { prompt: "b", chatId: 2, chatType: "private" });
    bridge.raw.prepare(`UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?
      WHERE chat_key = ?`).run(lockA!.runId, "different-acquisition", "chat-a");
    bridge.raw.prepare(`UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?
      WHERE chat_key = ?`).run("different-run", lockB!.acquisitionId, "chat-b");
    const beforeClaims = bridge.raw.prepare(
      "SELECT id, state, claim_run_id, claim_acquisition_id FROM pending_messages ORDER BY id"
    ).all();

    expect(bridge.reconcileStaleExecutionLocks({
      containmentState: () => "proven",
      lockState: () => "stale",
      reason: "mismatched-claim-boundary",
    })).toEqual([]);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM execution_locks").get()).toEqual({ n: 2 });
    expect(bridge.raw.prepare(
      "SELECT id, state, claim_run_id, claim_acquisition_id FROM pending_messages ORDER BY id"
    ).all()).toEqual(beforeClaims);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS n FROM reconciliation_audit").get()).toEqual({ n: 0 });
  });

  it("rolls back lock audit evidence when another connection wins the deletion race", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-lock-race-"));
    const path = join(root, "bridge.sqlite");
    const first = openDb(path);
    const second = openDb(path);
    try {
      const lock = first.acquireLock("telegram:interactive", "chat-race");
      expect(lock).not.toBeNull();
      const candidate = first.raw.prepare(
        "SELECT surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at FROM execution_locks WHERE surface = ? AND chat_key = ?"
      ).get(lock!.surface, lock!.chatKey);
      second.raw.prepare("DELETE FROM execution_locks WHERE surface = ? AND chat_key = ?")
        .run(lock!.surface, lock!.chatKey);
      expect(first.reconcileStaleExecutionLocks({
        candidateLocks: [candidate],
        containmentState: () => "proven",
        lockState: () => "stale",
        reason: "deletion-race",
      })).toEqual([]);
      expect(first.raw.prepare("SELECT COUNT(*) AS n FROM reconciliation_audit").get()).toEqual({ n: 0 });
    } finally {
      first.close();
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only exposes reconciliation_audit through the migration-owned schema", () => {
    const bridge = open();
    expect(Number(bridge.raw.pragma("user_version", { simple: true }))).toBe(8);
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

  it("leaves no audit residue when a second connection wins the reconciliation race", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-reconcile-race-"));
    const path = join(root, "bridge.sqlite");
    const first = openDb(path);
    const second = openDb(path);
    try {
      staleRun(first, "raced-run");
      const candidates = first.raw.prepare(
        "SELECT run_id, chat_id, bot, started_at FROM bridge_runs WHERE status = 'running'"
      ).all() as Array<{ run_id: string; chat_id: string; bot: string; started_at: string }>;
      const options = {
        nowMs: NOW,
        minAgeMs: 60_000,
        processState: () => "absent" as const,
        containmentState: () => "proven" as const,
      };

      expect(await second.reconcileOrphanedRuns(options)).toHaveLength(1);
      expect(await first.reconcileOrphanedRuns({ ...options, candidateRuns: candidates })).toEqual([]);
      expect(first.raw.prepare(
        "SELECT status, after_json FROM reconciliation_audit WHERE subject_id = ? ORDER BY created_at"
      ).all("raced-run")).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(first.raw.prepare(
        "SELECT type FROM bridge_events WHERE run_id = ? ORDER BY seq"
      ).all("raced-run")).toHaveLength(3);
    } finally {
      first.close();
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
