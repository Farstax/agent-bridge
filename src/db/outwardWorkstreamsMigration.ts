import type Database from "better-sqlite3";

/**
 * Version 25 (#1101): Workstream metadata on the existing outward ACP session
 * row. A Workstream is one outward ACP session bound to one stable Bridge
 * conversation ID, so no second identity or transcript table is introduced.
 * Nullable columns keep the previous release able to read and insert rows.
 */
export function applyOutwardWorkstreamsMigration(db: Database.Database, role?: string): void {
  if (role !== "interactive") return;
  const columns = new Set((db.prepare("PRAGMA table_info(outward_acp_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!columns.has("title")) db.exec("ALTER TABLE outward_acp_sessions ADD COLUMN title TEXT");
  if (!columns.has("archived_at")) db.exec("ALTER TABLE outward_acp_sessions ADD COLUMN archived_at TEXT");
}
