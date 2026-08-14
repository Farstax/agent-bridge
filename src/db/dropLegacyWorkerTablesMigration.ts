import type Database from "better-sqlite3";

/** Tables that belonged exclusively to the removed Engineering Worker. */
export const LEGACY_WORKER_TABLES = [
  "role_assignments",
  "role_assignment_revisions",
  "work_item_plans",
  "github_links",
  "approvals",
  "work_jobs",
  "work_items",
  "feature_plans",
] as const;

/**
 * Schema v9 removes the final persisted Engineering Worker surface.
 *
 * Historical migrations remain unchanged so old user_version values retain a
 * deterministic upgrade path. applyMigrationsUpTo() disables FK enforcement
 * around the migration transaction and runs foreign_key_check before commit;
 * child tables are still dropped before their parents for clarity and safety.
 */
export function dropLegacyWorkerTables(db: Database.Database): void {
  for (const table of LEGACY_WORKER_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}
