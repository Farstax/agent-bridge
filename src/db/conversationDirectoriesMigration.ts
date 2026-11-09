import type Database from "better-sqlite3";

/** V26: keep the outward ACP client workspace scope separate from provider cwd. */
export function applyConversationDirectoriesMigration(db: Database.Database, role?: string): void {
  if (role !== "interactive") return;
  const columns = new Set((db.prepare("PRAGMA table_info(outward_acp_sessions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!columns.has("execution_cwd")) db.exec("ALTER TABLE outward_acp_sessions ADD COLUMN execution_cwd TEXT");
}
