import type Database from "better-sqlite3";

/**
 * Issue #351: durable receipt boundary for one bounded authenticated
 * health/operations event scenario. Persisted before any Run is created so
 * duplicate delivery and restart-time replay can be detected without
 * re-executing work. Correlates to the ordinary owning bridge_runs row (the
 * "Run" in the issue's architecture diagram) the event triggered, and the
 * eventual result reference. Deliberately has no work_item/work_job
 * columns: routing this event through the Worker work_item/work_job/
 * task_type taxonomy was the original (superseded) design and would
 * recreate the mechanical workflow layer issue #347 removes.
 *
 * This migration has never shipped (schema version 6 is still unreleased),
 * so it is edited in place rather than compensated with a migration 7.
 */
export function applyEventReceiptsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE event_receipts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT NOT NULL,
      -- #351 only proves the health scenario; narrowed to just that source
      -- rather than pre-designing a taxonomy for sources nothing exercises
      -- yet. Widen with evidence when a second source is actually built.
      source           TEXT NOT NULL CHECK (source IN ('health')),
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
  db.exec("CREATE INDEX idx_event_receipts_source_kind ON event_receipts(source, event_kind)");
}
