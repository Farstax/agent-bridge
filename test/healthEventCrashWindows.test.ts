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
} from "../src/health/eventIngress.js";
import {
  healthRedEpisodeIdempotencyKey,
  reconcileTerminalPendingHealthEvents,
  replayablePendingHealthRunIds,
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
});
