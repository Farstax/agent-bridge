import type Database from "better-sqlite3";

function addColumnIfMissing(raw: Database.Database, sql: string): void {
  try {
    raw.exec(sql);
  } catch (err) {
    if (err instanceof Error && /duplicate column name/i.test(err.message)) return;
    throw err;
  }
}

/** Version 11: persist Cursor native session identity and circuit-breaker counters. */
export function applyCursorSessionColumnsMigration(raw: Database.Database): void {
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN cursor_session_id TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN cursor_session_created_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN cursor_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
}
