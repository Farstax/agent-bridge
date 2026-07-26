import type Database from "better-sqlite3";

/** Issue #193 durable reconciliation evidence is schema-owned, not startup DDL. */
export function applyReconciliationAuditMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE reconciliation_audit (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
      reason TEXT NOT NULL,
      cutoff_ms INTEGER,
      before_json TEXT NOT NULL,
      after_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  db.exec("CREATE INDEX idx_reconciliation_audit_subject ON reconciliation_audit(kind, subject_id, created_at)");
}
