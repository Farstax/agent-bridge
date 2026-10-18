import type Database from "better-sqlite3";

/**
 * Durable, host-wide provider execution claims.  Claims live in the existing
 * selected SQLite coordinator database; they are not a second queue or a
 * scheduler.  The lease is renewed by the same process that owns the provider
 * invocation and an expired claim is fenced before another process can reuse
 * its capacity.
 */
export function applyExecutionCapacityMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_capacity_claims (
      claim_id         TEXT PRIMARY KEY,
      service_id       TEXT NOT NULL,
      run_id           TEXT NOT NULL,
      acquisition_id   TEXT NOT NULL,
      execution_id     TEXT NOT NULL,
      acquired_at      TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_execution_capacity_claims_lease
      ON execution_capacity_claims(lease_expires_at);
  `);
}
