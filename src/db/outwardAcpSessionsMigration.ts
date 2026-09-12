import type Database from "better-sqlite3";

/** Version 17 owns durable outward ACP session -> Bridge conversation identity. */
export function applyOutwardAcpSessionsMigration(db: Database.Database, role?: string): void {
  if (role !== "interactive") return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outward_acp_sessions (
      session_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL UNIQUE,
      cwd TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}
