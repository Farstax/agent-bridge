import type Database from "better-sqlite3";

/** Version 16: persist Bridge conversation identity -> provider ACP session id. */
export function applyAcpSessionBindingsMigration(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS acp_session_bindings (
      conversation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      acp_session_id TEXT NOT NULL,
      last_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, provider_id)
    )
  `);
}
