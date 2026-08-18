import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { HealthReportStore } from "../src/health/reports.js";

describe("HealthReportStore", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `health-reports-test-${Date.now()}-${Math.random()}.sqlite`);
    db = new Database(dbPath);
    applyMigrations(db, undefined, "health");
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("excludes a previously persisted disabled plugin from the aggregate", () => {
    const reports = new HealthReportStore(db);
    const timestamp = new Date().toISOString();
    reports.saveReport({ pluginName: "agent-bridge", status: "green", checks: [], summary: "Healthy", timestamp });
    reports.saveReport({ pluginName: "server", status: "red", checks: [], summary: "Disk full", timestamp });

    const aggregate = reports.getAggregate({ activePluginNames: ["agent-bridge"], freshnessSeconds: 300 });

    expect(aggregate.status).toBe("green");
    expect(aggregate.evidence).toEqual({ missingPluginNames: [], stalePluginNames: [] });
    expect(aggregate.nonGreenReports).toEqual([]);
  });

  it("derives the worst current status without losing another plugin report", () => {
    const reports = new HealthReportStore(db);
    const timestamp = new Date().toISOString();
    reports.saveReport({ pluginName: "agent-bridge", status: "amber", checks: [], summary: "Updates", timestamp });
    reports.saveReport({ pluginName: "server", status: "red", checks: [], summary: "Disk full", timestamp });
    reports.saveReport({ pluginName: "agent-bridge", status: "green", checks: [], summary: "Healthy", timestamp });

    const aggregate = reports.getAggregate({ activePluginNames: ["agent-bridge", "server"], freshnessSeconds: 300 });

    expect(aggregate.status).toBe("red");
    expect(aggregate.reports.map((report) => report.pluginName)).toEqual(["agent-bridge", "server"]);
    expect(aggregate.nonGreenReports.map((report) => report.pluginName)).toEqual(["server"]);
  });

  it("marks missing and stale evidence separately from HealthStatus", () => {
    const reports = new HealthReportStore(db);
    reports.saveReport({ pluginName: "agent-bridge", status: "green", checks: [], summary: "Healthy", timestamp: new Date().toISOString() });
    const nowSeconds = Math.floor(Date.now() / 1000);

    const aggregate = reports.getAggregate({
      activePluginNames: ["agent-bridge", "server", "content-crawler"],
      freshnessSeconds: 10,
      nowSeconds: nowSeconds + 11,
    });

    expect(aggregate.status).toBeNull();
    expect(aggregate.evidence).toEqual({
      missingPluginNames: ["server", "content-crawler"],
      stalePluginNames: ["agent-bridge"],
    });
  });

  it("imports a valid legacy last report without inventing other plugin reports", () => {
    const report = { pluginName: "agent-bridge", status: "green" as const, checks: [], summary: "Healthy", timestamp: new Date().toISOString() };
    db.exec(`CREATE TABLE IF NOT EXISTS health_context (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_report_json TEXT,
      updated_at INTEGER
    )`);
    db.prepare("INSERT INTO health_context (id, last_report_json, updated_at) VALUES (1, ?, unixepoch())").run(JSON.stringify(report));

    const aggregate = new HealthReportStore(db).getAggregate({
      activePluginNames: ["agent-bridge", "server"],
      freshnessSeconds: 300,
    });

    expect(aggregate.status).toBe("green");
    expect(aggregate.evidence).toEqual({ missingPluginNames: ["server"], stalePluginNames: [] });
  });
});
