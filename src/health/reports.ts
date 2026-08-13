import type Database from "better-sqlite3";
import type { HealthAggregate, HealthReport, HealthStatus } from "./types.js";

export interface HealthAggregateOptions {
  activePluginNames: string[];
  freshnessSeconds: number;
  nowSeconds?: number;
}

interface StoredReport {
  plugin_name: string;
  report_json: string;
  saved_at: number;
}

function isHealthStatus(value: unknown): value is HealthStatus {
  return value === "green" || value === "amber" || value === "red";
}

function parseReport(value: string): HealthReport | null {
  try {
    const report = JSON.parse(value) as Partial<HealthReport>;
    if (typeof report.pluginName !== "string" || !isHealthStatus(report.status)) return null;
    return report as HealthReport;
  } catch {
    return null;
  }
}

function worstStatus(reports: HealthReport[]): HealthStatus | null {
  if (reports.some((report) => report.status === "red")) return "red";
  if (reports.some((report) => report.status === "amber")) return "amber";
  return reports.length ? "green" : null;
}

/** Bounded OSS-owned current-health read model. */
export class HealthReportStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrateLegacyLastReport();
  }

  saveReport(report: HealthReport): void {
    this.db.prepare(`
      INSERT INTO health_plugin_reports (plugin_name, report_json, saved_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(plugin_name) DO UPDATE SET
        report_json = excluded.report_json,
        saved_at = excluded.saved_at
    `).run(report.pluginName, JSON.stringify(report));
  }

  getReport(pluginName: string): HealthReport | null {
    const row = this.db.prepare(
      `SELECT report_json FROM health_plugin_reports WHERE plugin_name = ?`
    ).get(pluginName) as { report_json?: string } | undefined;
    return row?.report_json ? parseReport(row.report_json) : null;
  }

  getAggregate(options: HealthAggregateOptions): HealthAggregate {
    const activePluginNames = [...new Set(options.activePluginNames)];
    if (!activePluginNames.length) {
      return { status: null, reports: [], nonGreenReports: [], evidence: { missingPluginNames: [], stalePluginNames: [] } };
    }
    const placeholders = activePluginNames.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT plugin_name, report_json, saved_at FROM health_plugin_reports WHERE plugin_name IN (${placeholders})`
    ).all(...activePluginNames) as StoredReport[];
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const reportsByPlugin = new Map(rows.map((row) => [row.plugin_name, row]));
    const reports: HealthReport[] = [];
    const missingPluginNames: string[] = [];
    const stalePluginNames: string[] = [];

    for (const pluginName of activePluginNames) {
      const row = reportsByPlugin.get(pluginName);
      const report = row && parseReport(row.report_json);
      if (!report) missingPluginNames.push(pluginName);
      else if (nowSeconds - row.saved_at > options.freshnessSeconds) stalePluginNames.push(pluginName);
      else reports.push(report);
    }

    return {
      status: worstStatus(reports),
      reports,
      nonGreenReports: reports.filter((report) => report.status !== "green"),
      evidence: { missingPluginNames, stalePluginNames },
    };
  }

  private migrateLegacyLastReport(): void {
    const hasContext = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'health_context'"
    ).get();
    if (!hasContext) return;
    const row = this.db.prepare(
      "SELECT last_report_json, updated_at FROM health_context WHERE id = 1"
    ).get() as { last_report_json?: string | null; updated_at?: number } | undefined;
    if (!row?.last_report_json) return;
    const report = parseReport(row.last_report_json);
    if (!report) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO health_plugin_reports (plugin_name, report_json, saved_at)
      VALUES (?, ?, ?)
    `).run(report.pluginName, row.last_report_json, row.updated_at ?? Math.floor(Date.now() / 1000));
  }
}
