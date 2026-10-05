import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyConversationIdentityMigration } from "../src/db/conversationIdentityMigration.js";

function createLegacyBridgeState(db: Database.Database): void {
  db.exec(`CREATE TABLE bridge_state (
    chat_id TEXT PRIMARY KEY,
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
    cursor_consecutive_failures INTEGER NOT NULL DEFAULT 0
  );`);
}

function createLegacyAcpSessionBindings(db: Database.Database): void {
  db.exec(`CREATE TABLE acp_session_bindings (
    conversation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    last_run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, provider_id)
  );`);
}

function createLegacyBridgeRuns(db: Database.Database): void {
  db.exec(`CREATE TABLE bridge_runs (
    run_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    bot TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL
  );`);
}

function createOutwardAcpSessions(db: Database.Database): void {
  db.exec(`CREATE TABLE outward_acp_sessions (
    session_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    cwd TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
}

describe("conversation identity migration (v17 -> v18)", () => {
  it("recovers acp:outward provenance for ACP session bindings sharing a database with the Telegram interactive engine", () => {
    // The outward ACP stdio server and the Telegram interactive engine can
    // share one physical database file (both opened with databaseRole
    // "interactive"). Before v18, acp_session_bindings had no surface column
    // at all, so a row written by the outward ACP server and a row written
    // by ordinary Telegram-interactive ACP usage are indistinguishable by
    // shape alone -- only outward_acp_sessions (v17) proves which rows are
    // genuinely acp:outward.
    const db = new Database(":memory:");
    try {
      createLegacyBridgeState(db);
      createLegacyBridgeRuns(db);
      createLegacyAcpSessionBindings(db);
      createOutwardAcpSessions(db);

      db.prepare(`INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)`)
        .run("session-1", "outward-conversation-1", "/tmp");
      db.prepare(`INSERT INTO acp_session_bindings (conversation_id, provider_id, acp_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run("outward-conversation-1", "codex", "acp-outward-session", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      db.prepare(`INSERT INTO acp_session_bindings (conversation_id, provider_id, acp_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run("42", "codex", "acp-telegram-session", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

      applyConversationIdentityMigration(db, "interactive");

      const rows = db.prepare(`SELECT surface_identity, conversation_id, acp_session_id FROM acp_session_bindings ORDER BY conversation_id`).all() as Array<{ surface_identity: string; conversation_id: string; acp_session_id: string }>;
      expect(rows).toEqual([
        { surface_identity: "telegram:interactive", conversation_id: "42", acp_session_id: "acp-telegram-session" },
        { surface_identity: "acp:outward", conversation_id: "outward-conversation-1", acp_session_id: "acp-outward-session" },
      ]);
    } finally {
      db.close();
    }
  });

  it("does not fabricate acp:outward provenance when outward_acp_sessions is absent", () => {
    const db = new Database(":memory:");
    try {
      createLegacyBridgeState(db);
      createLegacyBridgeRuns(db);
      createLegacyAcpSessionBindings(db);
      db.prepare(`INSERT INTO acp_session_bindings (conversation_id, provider_id, acp_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run("42", "codex", "acp-telegram-session", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

      applyConversationIdentityMigration(db, "interactive");

      const rows = db.prepare(`SELECT surface_identity, conversation_id FROM acp_session_bindings`).all();
      expect(rows).toEqual([{ surface_identity: "telegram:interactive", conversation_id: "42" }]);
    } finally {
      db.close();
    }
  });

  it("keeps global polling offsets out of conversation scope while recovering acp:outward bridge_state rows", () => {
    const db = new Database(":memory:");
    try {
      createLegacyBridgeState(db);
      createLegacyBridgeRuns(db);
      createLegacyAcpSessionBindings(db);
      createOutwardAcpSessions(db);
      db.prepare(`INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)`)
        .run("session-1", "outward-conversation-1", "/tmp");
      db.prepare(`INSERT INTO bridge_state (chat_id, last_update_id) VALUES ('$polling:codex', 5)`).run();
      db.prepare(`INSERT INTO bridge_state (chat_id, codex_session_id) VALUES ('outward-conversation-1', 'native-leftover')`).run();
      db.prepare(`INSERT INTO bridge_state (chat_id, codex_session_id) VALUES ('42', 'telegram-native')`).run();

      applyConversationIdentityMigration(db, "interactive");

      const rows = db.prepare(`SELECT surface_identity, chat_id FROM bridge_state ORDER BY chat_id`).all();
      expect(rows).toEqual([
        { surface_identity: "$global", chat_id: "$polling:codex" },
        { surface_identity: "telegram:interactive", chat_id: "42" },
        { surface_identity: "acp:outward", chat_id: "outward-conversation-1" },
      ]);
    } finally {
      db.close();
    }
  });
});
