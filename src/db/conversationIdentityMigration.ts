import type Database from "better-sqlite3";

function legacySurface(role?: string): string {
  return role === "discord" ? "discord:interactive" : "telegram:interactive";
}

/** Version 18: make transport identity part of every conversation-scoped row. */
export function applyConversationIdentityMigration(db: Database.Database, role?: string): void {
  const surface = legacySurface(role);
  const columns = db.prepare("PRAGMA table_info(bridge_state)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "interactive_cli_preference")) {
    db.exec("ALTER TABLE bridge_state ADD COLUMN interactive_cli_preference TEXT");
  }
  db.exec(`
    ALTER TABLE bridge_state RENAME TO bridge_state_v17;
    CREATE TABLE bridge_state (
      surface_identity TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codex_session_id TEXT,
      gemini_session_id TEXT,
      claude_session_id TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id INTEGER NOT NULL DEFAULT 0,
      codex_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      claude_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      antigravity_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      codex_session_created_at TEXT,
      antigravity_session_created_at TEXT,
      claude_session_created_at TEXT,
      kimchi_session_id TEXT,
      kimchi_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      kimchi_session_created_at TEXT,
      grok_session_id TEXT,
      grok_session_created_at TEXT,
      grok_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cursor_session_id TEXT,
      cursor_session_created_at TEXT,
      cursor_consecutive_failures INTEGER NOT NULL DEFAULT 0,
      interactive_cli_preference TEXT,
      PRIMARY KEY (surface_identity, chat_id)
    );
    INSERT INTO bridge_state (
      surface_identity, chat_id, codex_session_id, gemini_session_id, claude_session_id,
      antigravity_session_id, active_execution_lock, last_update_id,
      codex_consecutive_failures, claude_consecutive_failures, antigravity_consecutive_failures,
      codex_session_created_at, antigravity_session_created_at, claude_session_created_at,
      kimchi_session_id, kimchi_consecutive_failures, kimchi_session_created_at,
      grok_session_id, grok_session_created_at, grok_consecutive_failures,
      cursor_session_id, cursor_session_created_at, cursor_consecutive_failures,
      interactive_cli_preference
    )
    SELECT CASE WHEN chat_id LIKE '$polling:%' THEN '$global' ELSE '${surface}' END,
      chat_id, codex_session_id, gemini_session_id, claude_session_id,
      antigravity_session_id, active_execution_lock, last_update_id,
      codex_consecutive_failures, claude_consecutive_failures, antigravity_consecutive_failures,
      codex_session_created_at, antigravity_session_created_at, claude_session_created_at,
      kimchi_session_id, kimchi_consecutive_failures, kimchi_session_created_at,
      grok_session_id, grok_session_created_at, grok_consecutive_failures,
      cursor_session_id, cursor_session_created_at, cursor_consecutive_failures,
      interactive_cli_preference
    FROM bridge_state_v17;
    DROP TABLE bridge_state_v17;

    ALTER TABLE acp_session_bindings RENAME TO acp_session_bindings_v17;
    CREATE TABLE acp_session_bindings (
      surface_identity TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      acp_session_id TEXT NOT NULL,
      last_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (surface_identity, conversation_id, provider_id)
    );
    INSERT INTO acp_session_bindings
      (surface_identity, conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at)
    SELECT '${surface}', conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at
      FROM acp_session_bindings_v17;
    DROP TABLE acp_session_bindings_v17;
  `);
  const runColumns = db.prepare("PRAGMA table_info(bridge_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "surface_identity")) {
    db.exec("ALTER TABLE bridge_runs ADD COLUMN surface_identity TEXT");
  }
}
