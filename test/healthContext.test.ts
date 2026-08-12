import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

describe("HealthContextStore", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `health-context-test-${Date.now()}.sqlite`);
    db = new Database(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("returns null when no context exists", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    expect(store.getContext()).toBeNull();
  });

  it("stores and retrieves a report", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = {
      pluginName: "test",
      status: "red" as const,
      checks: [{ name: "db-file", status: "red" as const, message: "missing" }],
      summary: "Critical",
      timestamp: new Date().toISOString(),
    };
    store.saveReport(report);
    const ctx = store.getContext();
    expect(ctx?.lastReport?.pluginName).toBe("test");
    expect(ctx?.lastReport?.status).toBe("red");
  });

  it("excludes a previously persisted disabled plugin from the aggregate", async () => {
    const { HealthReportStore } = await import("../src/health/reports.js");
    const reports = new HealthReportStore(db);
    const timestamp = new Date().toISOString();
    reports.saveReport({ pluginName: "agent-bridge", status: "green", checks: [], summary: "Healthy", timestamp });
    reports.saveReport({ pluginName: "server", status: "red", checks: [], summary: "Disk full", timestamp });

    const aggregate = reports.getAggregate({
      activePluginNames: ["agent-bridge"],
      freshnessSeconds: 300,
    });

    expect(aggregate.status).toBe("green");
    expect(aggregate.evidence).toEqual({ missingPluginNames: [], stalePluginNames: [] });
    expect(aggregate.nonGreenReports).toEqual([]);
  });

  it("derives the worst current status without losing another plugin report", async () => {
    const { HealthReportStore } = await import("../src/health/reports.js");
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

  it("marks missing and stale evidence separately from HealthStatus", async () => {
    const { HealthReportStore } = await import("../src/health/reports.js");
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

  it("imports valid legacy last-report evidence without inventing other plugin reports", async () => {
    db.exec(`CREATE TABLE health_context (id INTEGER PRIMARY KEY, last_report_json TEXT, updated_at INTEGER)`);
    const report = { pluginName: "agent-bridge", status: "green", checks: [], summary: "Healthy", timestamp: new Date().toISOString() };
    db.prepare("INSERT INTO health_context (id, last_report_json, updated_at) VALUES (1, ?, unixepoch())").run(JSON.stringify(report));

    const { HealthReportStore } = await import("../src/health/reports.js");
    const aggregate = new HealthReportStore(db).getAggregate({
      activePluginNames: ["agent-bridge", "server"],
      freshnessSeconds: 300,
    });

    expect(aggregate.status).toBe("green");
    expect(aggregate.evidence).toEqual({ missingPluginNames: ["server"], stalePluginNames: [] });
  });

  it("stores and retrieves a suggestion", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = { pluginName: "t", status: "red" as const, checks: [], summary: "s", timestamp: new Date().toISOString() };
    store.saveReport(report);
    store.saveSuggestion("Restart the worker");
    const ctx = store.getContext();
    expect(ctx?.lastSuggestion).toBe("Restart the worker");
  });

  it("stores and retrieves a session ID", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = { pluginName: "t", status: "red" as const, checks: [], summary: "s", timestamp: new Date().toISOString() };
    store.saveReport(report);
    store.saveSession("abc-123");
    const ctx = store.getContext();
    expect(ctx?.sessionId).toBe("abc-123");
    expect(ctx?.sessionStartedAt).not.toBeNull();
  });

  it("clearSession nulls session_id and session_started_at", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = { pluginName: "t", status: "red" as const, checks: [], summary: "s", timestamp: new Date().toISOString() };
    store.saveReport(report);
    store.saveSession("abc-123");
    store.clearSession();
    const ctx = store.getContext();
    expect(ctx?.sessionId).toBeNull();
    expect(ctx?.sessionStartedAt).toBeNull();
  });

  it("isSessionActive returns false when no session", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    expect(store.isSessionActive(1800)).toBe(false);
  });

  it("isSessionActive returns true within TTL", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = { pluginName: "t", status: "red" as const, checks: [], summary: "s", timestamp: new Date().toISOString() };
    store.saveReport(report);
    store.saveSession("abc-123");
    expect(store.isSessionActive(1800)).toBe(true);
  });

  it("isSessionActive returns false after TTL expires", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = { pluginName: "t", status: "red" as const, checks: [], summary: "s", timestamp: new Date().toISOString() };
    store.saveReport(report);
    store.saveSession("abc-123");
    // TTL of 0 seconds means immediately expired
    expect(store.isSessionActive(0)).toBe(false);
  });

  it("buildContextPrefix returns null when no context", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    expect(store.buildContextPrefix()).toBeNull();
  });

  it("buildContextPrefix includes report summary and suggestion", async () => {
    const { HealthContextStore } = await import("../src/health/context.js");
    const store = new HealthContextStore(db);
    const report = {
      pluginName: "content-crawler",
      status: "amber" as const,
      checks: [{ name: "queue-depth", status: "amber" as const, message: "381 items" }],
      summary: "Queue depth elevated",
      timestamp: new Date().toISOString(),
    };
    store.saveReport(report);
    store.saveSuggestion("Drain the queue by restarting worker");
    const prefix = store.buildContextPrefix();
    expect(prefix).toContain("content-crawler");
    expect(prefix).toContain("Queue depth elevated");
    expect(prefix).toContain("Drain the queue");
  });
});
