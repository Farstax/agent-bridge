import type Database from "better-sqlite3";

/**
 * Issue #351: durable receipt boundary for one bounded authenticated
 * health/operations event scenario. Persisted before any Run is created so
 * duplicate delivery and restart-time replay can be detected without
 * re-executing work. Links to the exact work_item/work_job ("Run") the
 * event triggered and the eventual result reference.
 */
export function applyEventReceiptsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE event_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL,
      source           TEXT NOT NULL CHECK (source IN ('health','schedule','github')),
      event_kind       TEXT NOT NULL,
      idempotency_key  TEXT NOT NULL UNIQUE,
      received_at      TEXT NOT NULL,
      occurred_at      TEXT NOT NULL,
      payload_json     TEXT NOT NULL DEFAULT '{}',
      authority_scope  TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','run_created','completed','failed','cancelled')),
      work_item_id     INTEGER,
      work_job_id      INTEGER,
      result_reference TEXT,
      error_class      TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(work_job_id) REFERENCES work_jobs(id)
    )
  `);
  db.exec("CREATE INDEX idx_event_receipts_source_kind ON event_receipts(source, event_kind)");
}
