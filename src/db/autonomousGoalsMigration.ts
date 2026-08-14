import type Database from "better-sqlite3";

/** Durable goal state and autonomous wake support for issue #392. */
export function applyAutonomousGoalsMigration(db: Database.Database): void {
  db.exec("DROP INDEX IF EXISTS idx_event_receipts_source_kind");
  db.exec("ALTER TABLE event_receipts RENAME TO event_receipts_v7");
  db.exec(`
    CREATE TABLE event_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL,
      source           TEXT NOT NULL CHECK (source IN ('health', 'autonomous')),
      event_kind       TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL UNIQUE,
      received_at      TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      payload_json     TEXT NOT NULL DEFAULT '{}',
      authority_scope  TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','run_created','completed','failed','cancelled')),
      run_id           TEXT,
      result_reference TEXT,
      error_class      TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
    )
  `);
  db.exec(`
    INSERT INTO event_receipts
      (id, event_id, source, event_kind, idempotency_key, received_at, occurred_at,
       payload_json, authority_scope, status, run_id, result_reference, error_class, created_at)
    SELECT id, event_id, source, event_kind, idempotency_key, received_at, occurred_at,
      payload_json, authority_scope, status, run_id, result_reference, error_class, created_at
    FROM event_receipts_v7
  `);
  db.exec("DROP TABLE event_receipts_v7");
  db.exec("CREATE INDEX idx_event_receipts_source_kind ON event_receipts(source, event_kind)");
  db.exec(`
    CREATE TABLE autonomous_goals (
      goal_id          TEXT PRIMARY KEY,
      prompt           TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      bot              TEXT NOT NULL,
      max_cycles       INTEGER NOT NULL CHECK (max_cycles > 0),
      cycle            INTEGER NOT NULL DEFAULT 0 CHECK (cycle >= 0),
      status           TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','complete','blocked','cancelled','budget_exhausted')),
      evidence_json    TEXT NOT NULL DEFAULT '[]',
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
