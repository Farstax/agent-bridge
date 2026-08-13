import type Database from "better-sqlite3";

/** Version 6 owns the health service's durable report read model. */
export function applyHealthSchemaMigration(db: Database.Database, role?: string): void {
  if (role !== "health") return;
  db.exec(`CREATE TABLE IF NOT EXISTS health_plugin_reports (
    plugin_name TEXT PRIMARY KEY, report_json TEXT NOT NULL, saved_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS health_context (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_report_json TEXT,
    last_suggestion TEXT,
    session_id TEXT,
    session_started_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}
