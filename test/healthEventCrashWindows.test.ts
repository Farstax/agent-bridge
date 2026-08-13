import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { HealthReportStore } from "../src/health/reports.js";
import {
  acceptHealthOpsEvent,
  healthEventExecutionStartedKey,
  resumeDurablePendingHealthEvents,
  HEALTH_RUN_SURFACE,
  HEALTH_RUN_CHAT_KEY,
} from "../src/health/eventIngress.js";
import {
  healthRedEpisodeIdempotencyKey,
  reconcileTerminalPendingHealthEvents,
  replayablePendingHealthRunIds,
  startedNonReplayableHealthRuns,
  reconcileAbandonedHealthLeases,
} from "../src/health/eventRecovery.js";
import type { HealthReport } from "../src/health/types.js";

const paths: string[] = [];
const token = "health-secret";

function dbPath(name: string): string {
  const path = join(tmpdir(), `${name}-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return path;
}

function report(status: HealthReport["status"], timestamp: string): HealthReport {
  return {
    pluginName: "content-crawler",
    status,
    summary: `status=${status}`,
    checks: [{ name: "queue", status, message: "bounded evidence" }],
    timestamp,
  };
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { rmSync(path); } catch {}
  }
});

describe("health event crash-window durability", () => {
  it("reconciles a terminal linked Run before replay can invoke the provider", async () => {
    const path = dbPath("health-terminal-reconcile");
    const db = openDb(path, { serviceId: "first", runId: "p1", databaseRole: "health" });
    const accepted = acceptHealthOpsEvent(db, {
      eventId: "evt-terminal",
      idempotencyKey: "health:terminal",
      occurredAt: "2026-08-13T12:00:00.000Z",
      report: report("red", "2026-08-13T12:00:00.000Z"),
      token,
    }, { expectedToken: token });
    db.updateRunCompleted(accepted.runId, "completed before crash", null);

    reconcileTerminalPendingHealthEvents(db);
    const executeSurfaceNeutralTurn = vi.fn();
    await resumeDurablePendingHealthEvents(db, { executeSurfaceNeutralTurn }, { bot: "claude" });

    expect(executeSurfaceNeutralTurn).not.toHaveBeenCalled();
    expect(db.getEventReceipt(accepted.receiptId)?.status).toBe("completed");
    db.close();
  });

  it("clears stale provider-start evidence only after a terminal Run is correlated", () => {
    const path = dbPath("health-start-marker");
    const db = openDb(path, { serviceId: "marker", runId: "p1", databaseRole: "health" });
    const accepted = acceptHealthOpsEvent(db, {
      eventId: "evt-marker",
      idempotencyKey: "health:marker",
      occurredAt: "2026-08-13T12:01:00.000Z",
      report: report("red", "2026-08-13T12:01:00.000Z"),
      token,
    }, { expectedToken: token });
    db.setSetting(healthEventExecutionStartedKey(accepted.receiptId), accepted.runId);
    db.updateRunFailed(accepted.runId, "interrupted after provider start");

    reconcileTerminalPendingHealthEvents(db);

    expect(db.getEventReceipt(accepted.receiptId)?.status).toBe("failed");
    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBeNull();
    db.close();
  });

  it("identifies only never-started running health Runs as replayable", () => {
    const path = dbPath("health-replayable-runs");
    const db = openDb(path, { serviceId: "replayable", runId: "p1", databaseRole: "health" });
    const replayable = acceptHealthOpsEvent(db, {
      eventId: "evt-replayable",
      idempotencyKey: "health:replayable",
      occurredAt: "2026-08-13T12:02:00.000Z",
      report: report("red", "2026-08-13T12:02:00.000Z"),
      token,
    }, { expectedToken: token });
    const started = acceptHealthOpsEvent(db, {
      eventId: "evt-started",
      idempotencyKey: "health:started",
      occurredAt: "2026-08-13T12:03:00.000Z",
      report: report("red", "2026-08-13T12:03:00.000Z"),
      token,
    }, { expectedToken: token });
    db.setSetting(healthEventExecutionStartedKey(started.receiptId), started.runId);

    expect(replayablePendingHealthRunIds(db)).toEqual(new Set([replayable.runId]));
    db.close();
  });

  it("reuses one red-episode key when a crash happens before the red report is persisted", () => {
    const path = dbPath("health-red-boundary");
    const first = openDb(path, { serviceId: "episode", runId: "p1", databaseRole: "health" });
    const store = new HealthReportStore(first.raw);
    store.saveReport(report("green", "2026-08-13T11:55:00.000Z"));

    const keyBeforeCrash = healthRedEpisodeIdempotencyKey("content-crawler", store.getReport("content-crawler"));
    const accepted = acceptHealthOpsEvent(first, {
      eventId: keyBeforeCrash,
      idempotencyKey: keyBeforeCrash,
      occurredAt: "2026-08-13T12:04:00.000Z",
      report: report("red", "2026-08-13T12:04:00.000Z"),
      token,
    }, { expectedToken: token });
    first.close();

    const restarted = openDb(path, { serviceId: "episode", runId: "p2", databaseRole: "health" });
    const restartedStore = new HealthReportStore(restarted.raw);
    const keyAfterCrash = healthRedEpisodeIdempotencyKey("content-crawler", restartedStore.getReport("content-crawler"));
    expect(keyAfterCrash).toBe(keyBeforeCrash);

    const replay = acceptHealthOpsEvent(restarted, {
      eventId: keyAfterCrash,
      idempotencyKey: keyAfterCrash,
      occurredAt: "2026-08-13T12:05:00.000Z",
      report: report("red", "2026-08-13T12:05:00.000Z"),
      token,
    }, { expectedToken: token });
    expect(replay.receiptId).toBe(accepted.receiptId);
    expect(replay.runId).toBe(accepted.runId);

    restartedStore.saveReport(report("green", "2026-08-13T12:10:00.000Z"));
    expect(healthRedEpisodeIdempotencyKey("content-crawler", restartedStore.getReport("content-crawler"))).not.toBe(keyBeforeCrash);
    restarted.close();
  });

  it("does not terminalize a Run interrupted after the provider-start marker until its abandoned health lane lease is proven stale", async () => {
    const path = dbPath("health-abandoned-lease");
    // bridge_runs.started_at is stamped from the real wall clock
    // (insertRun uses `new Date().toISOString()`, not an injectable clock),
    // so this test's `now` must track real time too — a fixed past
    // timestamp here would make the Run appear negatively-aged against
    // minAgeMs: 0 and mask the very defect under test.
    let now = Date.now();
    const clock = () => now;
    const leaseMs = 90_000;

    // Process generation A: accepts the event, acquires the health lane
    // exactly as executeHealthOpsRun does, writes the durable
    // provider-start marker, then crashes without ever releasing the lock
    // — leaving BOTH the marker and a live-looking execution_locks row
    // durable.
    const genA = openDb(path, { serviceId: "gen-a", runId: "run-a", lockLeaseMs: leaseMs, clock });
    const accepted = acceptHealthOpsEvent(genA, {
      eventId: "evt-abandoned-lease",
      idempotencyKey: "health:abandoned-lease",
      occurredAt: "2026-08-13T12:07:00.000Z",
      report: report("red", "2026-08-13T12:07:00.000Z"),
      token,
    }, { expectedToken: token });
    const laneHandle = genA.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(laneHandle).not.toBeNull();
    genA.setSetting(healthEventExecutionStartedKey(accepted.receiptId), accepted.runId);
    genA.close();

    // Process generation B starts immediately — before the lease has
    // expired. No provider replay (see the marker test above), and this
    // Run is both unreplayable and younger than the generic 60s cutoff, so
    // it must surface as a candidate for the health-specific reconciliation
    // pass.
    const genB = openDb(path, { serviceId: "gen-b", runId: "run-b", lockLeaseMs: leaseMs, clock });
    expect(replayablePendingHealthRunIds(genB)).toEqual(new Set());
    const candidates = startedNonReplayableHealthRuns(genB);
    expect(candidates.map((run) => run.run_id)).toEqual([accepted.runId]);

    // The lease has not genuinely expired yet: reconciliation must not
    // terminalize the Run merely because it is a candidate. The abandoned
    // lock row is what must gate this, not just the Run's age.
    await reconcileAbandonedHealthLeases(genB, { nowMs: now, processState: () => "absent" });
    expect(genB.getRun(accepted.runId).status).toBe("running");
    expect(genB.raw.prepare(
      "SELECT COUNT(*) AS n FROM execution_locks WHERE surface = ? AND chat_key = ?"
    ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY)).toEqual({ n: 1 });

    // The lease genuinely expires and the owning process is proven absent
    // — only now can the lane's lock be released and the Run terminalized.
    now += leaseMs + 1;
    await reconcileAbandonedHealthLeases(genB, { nowMs: now, processState: () => "absent" });
    expect(genB.getRun(accepted.runId).status).toBe("failed");
    expect(genB.raw.prepare(
      "SELECT COUNT(*) AS n FROM execution_locks WHERE surface = ? AND chat_key = ?"
    ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY)).toEqual({ n: 0 });

    reconcileTerminalPendingHealthEvents(genB);
    expect(genB.getEventReceipt(accepted.receiptId)?.status).toBe("failed");
    genB.close();
  });

  it("does not release or terminalize the abandoned lease while the owning process cannot be proven absent", async () => {
    const path = dbPath("health-abandoned-lease-live-process");
    let now = Date.now(); // see the wall-clock note in the test above
    const clock = () => now;
    const leaseMs = 90_000;

    const genA = openDb(path, { serviceId: "gen-a", runId: "run-a", lockLeaseMs: leaseMs, clock });
    const accepted = acceptHealthOpsEvent(genA, {
      eventId: "evt-live-process",
      idempotencyKey: "health:live-process",
      occurredAt: "2026-08-13T12:08:00.000Z",
      report: report("red", "2026-08-13T12:08:00.000Z"),
      token,
    }, { expectedToken: token });
    genA.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    genA.setSetting(healthEventExecutionStartedKey(accepted.receiptId), accepted.runId);
    genA.close();

    const genB = openDb(path, { serviceId: "gen-b", runId: "run-b", lockLeaseMs: leaseMs, clock });
    now += leaseMs + 1; // lease has expired, but the owning process is still (ambiguously) alive
    await reconcileAbandonedHealthLeases(genB, { nowMs: now, processState: () => "live" });

    expect(genB.getRun(accepted.runId).status).toBe("running");
    expect(genB.raw.prepare(
      "SELECT COUNT(*) AS n FROM execution_locks WHERE surface = ? AND chat_key = ?"
    ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY)).toEqual({ n: 1 });
    genB.close();
  });
});
