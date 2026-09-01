import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import { applyPendingMessageIdentityMigration } from "../src/db/pendingMessageIdentityMigration.js";
import { openDb } from "../src/db.js";

const DISCORD_CHAT_ID = "1234567890123456789";
const DISCORD_THREAD_ID = "2234567890123456789";
const DISCORD_USER_ID = "3234567890123456789";

function columnTypes(db: Database.Database): Map<string, string> {
  const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string; type: string }>;
  return new Map(columns.map((column) => [column.name, column.type.toUpperCase()]));
}

describe("pending message surface identities", () => {
  it("leaves a role-specific database without pending_messages unchanged", () => {
    const raw = new Database(":memory:");
    try {
      raw.exec("CREATE TABLE health_plugin_reports (plugin_name TEXT PRIMARY KEY, report_json TEXT NOT NULL, saved_at INTEGER NOT NULL)");
      applyPendingMessageIdentityMigration(raw);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_messages'").get()).toBeUndefined();
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_plugin_reports'").get()).toBeTruthy();
    } finally {
      raw.close();
    }
  });

  it("stores fresh queued delivery identities as lossless text", () => {
    const db = openDb(":memory:");
    try {
      const types = columnTypes(db.raw);
      expect(types.get("chat_id")).toBe("TEXT");
      expect(types.get("thread_id")).toBe("TEXT");
      expect(types.get("user_id")).toBe("TEXT");

      db.enqueueMsg("discord:interactive", DISCORD_CHAT_ID, {
        prompt: "queued prompt",
        chatId: DISCORD_CHAT_ID,
        threadId: DISCORD_THREAD_ID,
        chatType: "guild",
        userId: DISCORD_USER_ID,
      });

      expect(db.dequeueMsgs("discord:interactive", DISCORD_CHAT_ID)).toEqual([
        expect.objectContaining({
          prompt: "queued prompt",
          chatId: DISCORD_CHAT_ID,
          threadId: DISCORD_THREAD_ID,
          userId: DISCORD_USER_ID,
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("migrates exact legacy INTEGER identities without a JavaScript number round-trip", () => {
    const raw = new Database(":memory:");
    try {
      raw.exec(`
        CREATE TABLE pending_messages (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          surface              TEXT NOT NULL DEFAULT 'legacy',
          chat_key             TEXT NOT NULL,
          prompt               TEXT NOT NULL,
          chat_id              INTEGER NOT NULL,
          thread_id            INTEGER,
          chat_type            TEXT NOT NULL DEFAULT 'private',
          user_id              INTEGER,
          state                TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed')),
          claim_run_id         TEXT,
          claim_acquisition_id TEXT,
          claimed_at           TEXT,
          attachments_json     TEXT NOT NULL DEFAULT '[]',
          created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX idx_pending_msgs_surface_chat_key
          ON pending_messages(surface, chat_key, id);
        INSERT INTO pending_messages (
          surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id
        ) VALUES (
          'discord:interactive', '${DISCORD_CHAT_ID}', 'legacy queued prompt',
          ${DISCORD_CHAT_ID}, ${DISCORD_THREAD_ID}, 'guild', ${DISCORD_USER_ID}
        );
        PRAGMA user_version = 12;
      `);

      applyMigrations(raw);

      expect(raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      const types = columnTypes(raw);
      expect(types.get("chat_id")).toBe("TEXT");
      expect(types.get("thread_id")).toBe("TEXT");
      expect(types.get("user_id")).toBe("TEXT");
      expect(raw.prepare(`
        SELECT chat_id AS chatId, thread_id AS threadId, user_id AS userId
        FROM pending_messages
      `).get()).toEqual({
        chatId: DISCORD_CHAT_ID,
        threadId: DISCORD_THREAD_ID,
        userId: DISCORD_USER_ID,
      });
    } finally {
      raw.close();
    }
  });
});
