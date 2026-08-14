import type Database from "better-sqlite3";

/**
 * Schema version 9 removes the persisted Engineering Worker product model.
 * These tables have no current runtime owner. Their data is obsolete by
 * design, so the migration removes populated tables as well as empty ones.
 *
 * Drop children before parents while foreign-key enforcement is suspended by
 * the shared migration runner. The runner restores enforcement and performs a
 * full foreign_key_check before committing the new schema version.
 */
export function dropLegacyWorkerTablesMigration(raw: Database.Database): void {
  raw.exec(`
    DROP TABLE IF EXISTS work_item_plans;
    DROP TABLE IF EXISTS approvals;
    DROP TABLE IF EXISTS github_links;
    DROP TABLE IF EXISTS work_jobs;
    DROP TABLE IF EXISTS work_items;
    DROP TABLE IF EXISTS role_assignments;
    DROP TABLE IF EXISTS role_assignment_revisions;
    DROP TABLE IF EXISTS feature_plans;
  `);
}
