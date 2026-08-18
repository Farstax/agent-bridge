import type Database from "better-sqlite3";

/** Version 6 owns the health service's durable report read model. */
export function applyHealthSchemaMigration(db: Database.Database, role?: string): void {
  if (role !== "health") return;
  db.exec(`CREATE TABLE IF NOT EXISTS health_plugin_reports (
    plugin_name TEXT PRIMARY KEY, report_json TEXT NOT NULL, saved_at INTEGER NOT NULL
  )`);
}
