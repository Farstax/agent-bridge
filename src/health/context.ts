import type Database from "better-sqlite3";
import type { HealthReport } from "./types.js";
import { formatReport } from "./reporter.js";

export interface HealthContext {
  lastReport: HealthReport | null;
  lastSuggestion: string | null;
  sessionId: string | null;
  sessionStartedAt: number | null;
  updatedAt: number;
}

export class HealthContextStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  saveReport(report: HealthReport): void {
    this.db.prepare(`
      INSERT INTO health_context (id, last_report_json, updated_at)
      VALUES (1, ?, unixepoch())
      ON CONFLICT(id) DO UPDATE SET
        last_report_json = excluded.last_report_json,
        last_suggestion = NULL,
        session_id = NULL,
        session_started_at = NULL,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(report));
  }

  saveSuggestion(text: string): void {
    this.db.prepare(
      `UPDATE health_context SET last_suggestion = ?, updated_at = unixepoch() WHERE id = 1`
    ).run(text);
  }

  saveSession(sessionId: string): void {
    this.db.prepare(
      `UPDATE health_context SET session_id = ?, session_started_at = unixepoch(), updated_at = unixepoch() WHERE id = 1`
    ).run(sessionId);
  }

  clearSession(): void {
    this.db.prepare(
      `UPDATE health_context SET session_id = NULL, session_started_at = NULL WHERE id = 1`
    ).run();
  }

  getContext(): HealthContext | null {
    const row = this.db.prepare(`SELECT * FROM health_context WHERE id = 1`).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      lastReport: row.last_report_json ? (JSON.parse(row.last_report_json as string) as HealthReport) : null,
      lastSuggestion: (row.last_suggestion as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      sessionStartedAt: (row.session_started_at as number | null) ?? null,
      updatedAt: row.updated_at as number,
    };
  }

  isSessionActive(ttlSeconds: number): boolean {
    const ctx = this.getContext();
    if (!ctx?.sessionId || ctx.sessionStartedAt === null) return false;
    const now = Math.floor(Date.now() / 1000);
    return now - ctx.sessionStartedAt < ttlSeconds;
  }

  buildContextPrefix(): string | null {
    const ctx = this.getContext();
    if (!ctx?.lastReport) return null;
    const lines = [
      `[Health monitor context — last check: ${ctx.lastReport.timestamp}]`,
      formatReport(ctx.lastReport),
    ];
    if (ctx.lastSuggestion) {
      lines.push("", "Previous suggestion:", ctx.lastSuggestion);
    }
    lines.push("", "---");
    return lines.join("\n");
  }
}
