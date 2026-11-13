import type Database from "better-sqlite3";

/** Widen the existing receipt source CHECK for authenticated Telegram polling. */
export function applyTelegramReceiptsMigration(db: Database.Database): void {
  // The guarded migration driver disables foreign keys around schema copies
  // and runs foreign_key_check before committing.
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'event_receipts'").get();
  db.exec("DROP INDEX IF EXISTS idx_event_receipts_source_kind");
  if (exists) db.exec("ALTER TABLE event_receipts RENAME TO event_receipts_v26");
  db.exec(`
    CREATE TABLE event_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL,
      source           TEXT NOT NULL CHECK (source IN ('health', 'autonomous', 'slack', 'telegram')),
      event_kind       TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL UNIQUE,
      received_at      TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      payload_json     TEXT NOT NULL DEFAULT '{}',
      authority_scope  TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received','dispatching','run_created','completed','failed','cancelled','ambiguous')),
      run_id           TEXT,
      result_reference TEXT,
      error_class      TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
    )
  `);
  if (exists) {
    db.exec(`
      INSERT INTO event_receipts
        (id, event_id, source, event_kind, idempotency_key, received_at, occurred_at,
         payload_json, authority_scope, status, run_id, result_reference, error_class, created_at)
      SELECT id, event_id, source, event_kind, idempotency_key, received_at, occurred_at,
        payload_json, authority_scope, status, run_id, result_reference, error_class, created_at
      FROM event_receipts_v26
    `);
    db.exec("DROP TABLE event_receipts_v26");
  }
  db.exec("CREATE INDEX idx_event_receipts_source_kind ON event_receipts(source, event_kind)");
}
