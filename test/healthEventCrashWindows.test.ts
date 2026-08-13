import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { HealthReportStore } from "../src/health/reports.js";
import {
  acceptHealthOpsEvent,
  executeHealthOpsRun,
  healthEventExecutionStartedKey,
  healthRedEpisodeIdempotencyKey,
  reconcileEventReceiptResult,
  resumeDurablePendingHealthEvents,
} from "../src/health/eventIngress.js";
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
  it("reconciles a terminal linked Run without invoking the provider again after restart", async () => {
    const path = dbPath("health-terminal-reconcile");
    const first = openDb(path, { serviceId: "first", runId: "p1", databaseRole: "health" });
    const accepted = acceptHealthOpsEvent(first, {
      eventId: "evt-terminal",
      idempotencyKey: "health:terminal",
      occurredAt: "2026-08-13T12:00:00.000Z",
      report: report("red", "2026-08-13T12:00:00.000Z"),
      token,
    }, { expectedToken: token });
    first.updateRunCompleted(accepted.runId, "completed before crash", null);
    first.close();

    const restarted = openDb(path, { serviceId: "second", runId: "p2", databaseRole: "health" });
    const executeSurfaceNeutralTurn = vi.fn();
    await resumeDurablePendingHealthEvents(restarted, { executeSurfaceNeutralTurn }, { bot: "claude" });

    expect(executeSurfaceNeutralTurn).not.toHaveBeenCalled();
    expect(restarted.getEventReceipt(accepted.receiptId)?.status).toBe("completed");
    restarted.close();
  });

  it("keeps provider-start evidence until the terminal receipt is reconciled", async () => {
    const path = dbPath("health-start-marker");
    const db = openDb(path, { serviceId: "marker", runId: "p1", databaseRole: "health" });
    const accepted = acceptHealthOpsEvent(db, {
      eventId: "evt-marker",
      idempotencyKey: "health:marker",
      occurredAt: "2026-08-13T12:01:00.000Z",
      report: report("red", "2026-08-13T12:01:00.000Z"),
      token,
    }, { expectedToken: token });

    const executeSurfaceNeutralTurn = vi.fn(async (input: any) => {
      input.onProviderExecutionStarted?.();
      db.updateRunCompleted(accepted.runId, "done", null);
      return {} as any;
    });

    await executeHealthOpsRun(db, accepted.receiptId, { executeSurfaceNeutralTurn }, { bot: "claude" });
    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBe(accepted.runId);

    reconcileEventReceiptResult(db, accepted.receiptId);
    expect(db.getEventReceipt(accepted.receiptId)?.status).toBe("completed");
    expect(db.getSetting(healthEventExecutionStartedKey(accepted.receiptId))).toBeNull();
    db.close();
  });

  it("reuses one red-episode idempotency key when a crash happens before the red report is persisted", () => {
    const path = dbPath("health-red-boundary");
    const first = openDb(path, { serviceId: "episode", runId: "p1", databaseRole: "health" });
    const store = new HealthReportStore(first.raw);
    const priorGreen = report("green", "2026-08-13T11:55:00.000Z");
    store.saveReport(priorGreen);

    const keyBeforeCrash = healthRedEpisodeIdempotencyKey("content-crawler", store.getReport("content-crawler"));
    const accepted = acceptHealthOpsEvent(first, {
      eventId: keyBeforeCrash,
      idempotencyKey: keyBeforeCrash,
      occurredAt: "2026-08-13T12:02:00.000Z",
      report: report("red", "2026-08-13T12:02:00.000Z"),
      token,
    }, { expectedToken: token });
    // Simulate process loss before HealthBridgeBot persists the incoming red report.
    first.close();

    const restarted = openDb(path, { serviceId: "episode", runId: "p2", databaseRole: "health" });
    const restartedStore = new HealthReportStore(restarted.raw);
    const keyAfterCrash = healthRedEpisodeIdempotencyKey("content-crawler", restartedStore.getReport("content-crawler"));
    expect(keyAfterCrash).toBe(keyBeforeCrash);

    const replay = acceptHealthOpsEvent(restarted, {
      eventId: keyAfterCrash,
      idempotencyKey: keyAfterCrash,
      occurredAt: "2026-08-13T12:03:00.000Z",
      report: report("red", "2026-08-13T12:03:00.000Z"),
      token,
    }, { expectedToken: token });
    expect(replay.receiptId).toBe(accepted.receiptId);
    expect(replay.runId).toBe(accepted.runId);

    const recoveredGreen = report("green", "2026-08-13T12:10:00.000Z");
    restartedStore.saveReport(recoveredGreen);
    expect(healthRedEpisodeIdempotencyKey("content-crawler", restartedStore.getReport("content-crawler"))).not.toBe(keyBeforeCrash);
    restarted.close();
  });
});
