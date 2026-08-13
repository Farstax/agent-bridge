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
import type { HealthReport } from "../src/health/types.js";

const paths: string[] = [];
const token = "health-secret";

function report(status: HealthReport["status"] = "red"): HealthReport {
  return {
    pluginName: "content-crawler",
    status,
    summary: `status=${status}`,
    checks: [{ name: "queue", status, message: "bounded evidence" }],
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { rmSync(path); } catch {}
  }
});

describe("health event restart durability", () => {
  it("uses the durable report read model to keep red episodes stable across restart", () => {
    const path = join(tmpdir(), `health-red-episode-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "red-episode", runId: "p1", databaseRole: "health" });
    const store = new HealthReportStore(db.raw);
    store.saveReport(report("red"));
    db.close();

    const restarted = openDb(path, { serviceId: "red-episode", runId: "p2", databaseRole: "health" });
    expect(new HealthReportStore(restarted.raw).getReport("content-crawler")?.status).toBe("red");
    restarted.close();
  });

  it("does not replay a receipt whose durable marker proves provider execution started", async () => {
    const path = join(tmpdir(), `health-started-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "started", runId: "p1", databaseRole: "health" });
    const accepted = acceptHealthOpsEvent(db, {
      eventId: "evt-started",
      idempotencyKey: "health:started",
      occurredAt: new Date().toISOString(),
      report: report("red"),
      token,
    }, { expectedToken: token });
    db.setSetting(healthEventExecutionStartedKey(accepted.receiptId), accepted.runId);
    db.close();

    const restarted = openDb(path, { serviceId: "started", runId: "p2", databaseRole: "health" });
    const executeSurfaceNeutralTurn = vi.fn();
    await resumeDurablePendingHealthEvents(restarted, { executeSurfaceNeutralTurn }, { bot: "claude" });
    expect(executeSurfaceNeutralTurn).not.toHaveBeenCalled();
    expect(restarted.getRun(accepted.runId).status).toBe("running");
    restarted.close();
  });
});
