import type Database from "better-sqlite3";

/** Persist the owning scheduled-occurrence key on queued work so correlation survives restart. */
export function applyScheduledOccurrenceCorrelationMigration(db: Database.Database): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_messages'").get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "scheduled_occurrence_key")) return;
  db.exec("ALTER TABLE pending_messages ADD COLUMN scheduled_occurrence_key TEXT");
}
