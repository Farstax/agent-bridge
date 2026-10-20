import type Database from "better-sqlite3";

/** Run-scoped outcome columns are retained and pruned with the owning bridge_runs row. */
export function applyRunOutcomeMigration(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(bridge_runs)").all() as Array<{ name: string }>).map(c => c.name));
  if (!columns.has("outcome_status")) {
    db.exec("ALTER TABLE bridge_runs ADD COLUMN outcome_status TEXT CHECK (outcome_status IN ('complete', 'continue', 'blocked'))");
  }
  if (!columns.has("outcome_detail")) {
    db.exec("ALTER TABLE bridge_runs ADD COLUMN outcome_detail TEXT");
  }
}
