import type Database from "better-sqlite3";

/** Preserve the one user-visible local-capacity notice with the durable receipt. */
export function applyExecutionCapacityNotificationMigration(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "execution_capacity_notified")) {
    db.exec("ALTER TABLE pending_messages ADD COLUMN execution_capacity_notified INTEGER NOT NULL DEFAULT 0");
  }
}
