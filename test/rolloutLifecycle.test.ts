import { afterEach, describe, expect, it } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import { classifyLifecycleState } from "../src/rolloutLifecycle.js";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");

function run(run_id: string, status = "running") {
  return { run_id, chat_id: "chat-1", bot: "codex", status, started_at: "2026-07-29T11:00:00.000Z" };
}

function lock(run_id: string, acquisition_id: string, lease_expires_at = "2026-07-29T12:30:00.000Z") {
  return {
    surface: "telegram:interactive",
    chat_key: "chat-1",
    service_id: "telegram:interactive",
    run_id,
    acquisition_id,
    acquired_at: "2026-07-29T11:00:00.000Z",
    lease_expires_at,
  };
}

describe("rollout lifecycle classification", () => {
  it("classifies the interactive deployment-originating run as live-correlated", () => {
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: run("bot-run"),
      locks: [lock("bot-run", "acq-1")],
      claims: [],
      process: { state: "live", run_id: "bot-run", service_id: "telegram:interactive", acquisition_id: "acq-1" },
    })).toBe("live-correlated");
  });

  it("allows three interactive running rows when only the bot-owned row has a live lock", () => {
    const rows = [run("interactive-1"), run("interactive-2"), run("bot-run")];
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: rows[0],
      locks: [],
      claims: [],
      process: { state: "absent", run_id: rows[0].run_id },
    })).toBe("stale-unowned");
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: rows[1],
      locks: [],
      claims: [],
      process: { state: "absent", run_id: rows[1].run_id },
    })).toBe("stale-unowned");
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: rows[2],
      locks: [lock("bot-run", "acq-1")],
      claims: [],
      process: { state: "live", run_id: "bot-run", service_id: "telegram:interactive", acquisition_id: "acq-1" },
    })).toBe("live-correlated");
  });

  it("classifies six health stale runs and the worker stale run as stale-unowned", () => {
    for (const runId of [...Array.from({ length: 6 }, (_, index) => `health-${index + 1}`), "cc65d327-5c0c-4166-906e-be09877d1220"]) {
      expect(classifyLifecycleState({
        nowMs: NOW,
        run: run(runId),
        locks: [],
        claims: [],
        process: { state: "absent", run_id: runId },
      })).toBe("stale-unowned");
    }
  });

  it.each([
    ["missing process identity", { state: "ambiguous", run_id: "run-1" }],
    ["mismatched process run", { state: "live", run_id: "other-run", service_id: "telegram:interactive", acquisition_id: "acq-1" }],
    ["mismatched acquisition", { state: "live", run_id: "run-1", service_id: "telegram:interactive", acquisition_id: "other-acq" }],
    ["live process without a lock", { state: "live", run_id: "run-1", service_id: "telegram:interactive", acquisition_id: "acq-1" }],
  ])("fails closed for %s", (_label, process) => {
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: run("run-1"),
      locks: _label === "live process without a lock" ? [] : [lock("run-1", "acq-1")],
      claims: [],
      process,
    })).toBe("ambiguous");
  });

  it("fails closed for an unknown lock and any claimed ownership", () => {
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: run("run-1"),
      locks: [lock("other-run", "acq-1")],
      claims: [],
      process: { state: "absent", run_id: "run-1" },
    })).toBe("ambiguous");
    expect(classifyLifecycleState({
      nowMs: NOW,
      run: run("run-1"),
      locks: [],
      claims: [{ run_id: "run-1", acquisition_id: "acq-1" }],
      process: { state: "absent", run_id: "run-1" },
    })).toBe("ambiguous");
  });
});

describe("controlled rollout lifecycle reconciliation", () => {
  let db: BridgeDb;

  function open(): BridgeDb {
    db = openDb(":memory:");
    return db;
  }

  afterEach(() => db?.close());

  it("fails the contained run, appends audit/events, and releases only its exact unclaimed lock", () => {
    const bridge = open();
    bridge.insertRun("contained-run", "chat-1", "codex");
    bridge.raw.prepare("UPDATE bridge_runs SET started_at = ? WHERE run_id = ?")
      .run("2026-07-29T11:00:00.000Z", "contained-run");
    const lane = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lane).not.toBeNull();

    const beforeRuns = bridge.raw.prepare("SELECT * FROM bridge_runs").all();
    const beforeEvents = bridge.raw.prepare("SELECT * FROM bridge_events").all();
    expect(bridge.reconcileControlledRollout({
      nowMs: NOW,
      reason: "interrupted_by_controlled_rollout",
      processState: () => "absent",
      containmentState: () => "proven",
    })).toMatchObject({ reconciledRunIds: ["contained-run"], releasedLockCount: 1 });

    expect(bridge.getRun("contained-run")).toMatchObject({ status: "failed", error: "interrupted_by_controlled_rollout" });
    expect(bridge.raw.prepare("SELECT * FROM execution_locks").all()).toEqual([]);
    expect(bridge.raw.prepare("SELECT kind, status, reason FROM reconciliation_audit").all()).toEqual([
      { kind: "run", status: "completed", reason: "interrupted_by_controlled_rollout" },
      { kind: "lock", status: "completed", reason: "interrupted_by_controlled_rollout" },
    ]);
    expect(bridge.raw.prepare("SELECT type FROM bridge_events ORDER BY seq").all()).toEqual([
      { type: "reconciliation.started" },
      { type: "run.reconciled" },
      { type: "reconciliation.completed" },
    ]);
    expect(bridge.raw.prepare("SELECT run_id, chat_id, bot FROM bridge_runs").all()).toEqual(
      beforeRuns.map((row: any) => ({ run_id: row.run_id, chat_id: row.chat_id, bot: row.bot })),
    );
    expect(bridge.raw.prepare("SELECT id, run_id, seq, type FROM bridge_events").all().length)
      .toBe(beforeEvents.length + 3);
  });

  it("fails closed and preserves claims, queues, runs, locks and events when claim ownership is unresolved", () => {
    const bridge = open();
    bridge.insertRun("claimed-run", "chat-1", "codex");
    const lane = bridge.acquireLock("telegram:interactive", "chat-1");
    bridge.enqueueMsg("telegram:interactive", "chat-1", { prompt: "preserve", chatId: 1, chatType: "private" });
    bridge.raw.prepare("UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?")
      .run("claimed-run", lane!.acquisitionId);
    const before = bridge.raw.prepare("SELECT * FROM pending_messages").all();

    expect(() => bridge.reconcileControlledRollout({
      nowMs: NOW,
      reason: "interrupted_by_controlled_rollout",
      processState: () => "absent",
      containmentState: () => "proven",
    })).toThrow(/claim|ambiguous/i);
    expect(bridge.getRun("claimed-run").status).toBe("running");
    expect(bridge.raw.prepare("SELECT * FROM pending_messages").all()).toEqual(before);
    expect(bridge.raw.prepare("SELECT COUNT(*) AS count FROM execution_locks").get()).toEqual({ count: 1 });
    expect(bridge.raw.prepare("SELECT COUNT(*) AS count FROM reconciliation_audit").get()).toEqual({ count: 0 });
  });
});
