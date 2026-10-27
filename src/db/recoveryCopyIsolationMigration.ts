import type Database from "better-sqlite3";

/** Retains execution-capacity claims removed while separating a recovery copy. */
export function applyRecoveryCopyIsolationMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_copy_execution_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      copy_id TEXT NOT NULL,
      record_type TEXT NOT NULL CHECK (record_type IN ('execution_capacity_claim', 'pending_message', 'execution_lock')),
      record_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      UNIQUE(copy_id, record_type, record_key)
    )
  `);
}
