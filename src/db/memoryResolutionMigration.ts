import type Database from "better-sqlite3";

/**
 * Issue #304: lets a memory entry be marked resolved/superseded (by id)
 * instead of remaining indistinguishable from an open blocker.
 *
 * Also repairs the pm_ad/pm_au triggers created by the version-1 baseline.
 * Those used FTS5's contentless-table "special delete command" syntax
 * (`INSERT INTO fts(fts, rowid, ...) VALUES('delete', ...)`), which only
 * applies to external-content fts5 tables; project_memories_fts is a plain
 * standalone fts5 table, so that form raises "SQL logic error" and any
 * UPDATE or DELETE on project_memories has always failed. Never observed
 * before because nothing previously updated or deleted a memory row.
 * Replaced with plain DELETE FROM ... WHERE rowid = ?, which is valid for
 * any fts5 table.
 */
export function applyMemoryResolutionMigration(db: Database.Database): void {
  // A guarded rollout can re-run this step against a database that already
  // has the column (e.g. a partial rollback that only rewinds user_version),
  // so this must tolerate being re-applied, like the baseline migration's
  // addColumnIfMissing helper.
  try {
    db.exec(`ALTER TABLE project_memories ADD COLUMN resolved_by TEXT`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column name/i.test(err.message)) throw err;
  }

  db.exec(`
    DROP TRIGGER pm_ad;
    DROP TRIGGER pm_au;

    CREATE TRIGGER pm_ad AFTER DELETE ON project_memories BEGIN
      DELETE FROM project_memories_fts WHERE rowid = old.rowid;
    END;
    CREATE TRIGGER pm_au AFTER UPDATE ON project_memories BEGIN
      DELETE FROM project_memories_fts WHERE rowid = old.rowid;
      INSERT INTO project_memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
    END;
  `);
}
