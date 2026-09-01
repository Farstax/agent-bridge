import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import { applyPendingMessageIdentityMigration } from "../src/db/pendingMessageIdentityMigration.js";
import { applyPendingMessageIdentityRepairMigration } from "../src/db/pendingMessageIdentityRepairMigration.js";
import { openDb } from "../src/db.js";

const DISCORD_18_DIGIT_ID = "123456789012345678";
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
      applyPendingMessageIdentityRepairMigration(raw);
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
      expect(types.get("chat_id")).toBe("BLOB");
      expect(types.get("thread_id")).toBe("BLOB");
      expect(types.get("user_id")).toBe("BLOB");

      db.enqueueMsg("discord:interactive", DISCORD_CHAT_ID, {
        prompt: "queued prompt",
        chatId: DISCORD_CHAT_ID,
        threadId: DISCORD_THREAD_ID,
        chatType: "guild",
        userId: DISCORD_USER_ID,
      });
      db.enqueueMsg("discord:interactive", DISCORD_18_DIGIT_ID, {
        prompt: "18 digit queued prompt",
        chatId: DISCORD_18_DIGIT_ID,
        threadId: DISCORD_18_DIGIT_ID,
        chatType: "guild",
        userId: DISCORD_18_DIGIT_ID,
      });

      expect(db.dequeueMsgs("discord:interactive", DISCORD_CHAT_ID)).toEqual([
        expect.objectContaining({
          prompt: "queued prompt",
          chatId: DISCORD_CHAT_ID,
          threadId: DISCORD_THREAD_ID,
          userId: DISCORD_USER_ID,
        }),
      ]);
      expect(db.dequeueMsgs("discord:interactive", DISCORD_18_DIGIT_ID)[0]).toMatchObject({
        chatId: DISCORD_18_DIGIT_ID,
        threadId: DISCORD_18_DIGIT_ID,
        userId: DISCORD_18_DIGIT_ID,
      });
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
      expect(types.get("chat_id")).toBe("BLOB");
      expect(types.get("thread_id")).toBe("BLOB");
      expect(types.get("user_id")).toBe("BLOB");
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

  it("keeps numeric Telegram coordinates numeric for fresh and migrated rows", () => {
    const db = openDb(":memory:");
    try {
      db.enqueueMsg("telegram:interactive", "100", {
        prompt: "fresh Telegram row",
        chatId: 100,
        threadId: 7,
        chatType: "private",
        userId: 200,
      });
      expect(db.dequeueMsgs("telegram:interactive", "100")[0]).toMatchObject({
        chatId: 100,
        threadId: 7,
        userId: 200,
      });
      const fresh = db.dequeueMsgs("telegram:interactive", "100")[0];
      expect(typeof fresh.chatId).toBe("number");
      expect(typeof fresh.threadId).toBe("number");
      expect(typeof fresh.userId).toBe("number");
    } finally {
      db.close();
    }

    const raw = new Database(":memory:");
    try {
      raw.exec(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, surface TEXT NOT NULL, chat_key TEXT NOT NULL,
          prompt TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT, chat_type TEXT NOT NULL,
          user_id TEXT, state TEXT NOT NULL, claim_run_id TEXT, claim_acquisition_id TEXT,
          claimed_at TEXT, attachments_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_pending_msgs_surface_chat_key ON pending_messages(surface, chat_key, id);
        INSERT INTO pending_messages(surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, state, attachments_json, created_at)
        VALUES ('telegram:interactive', '100', 'old Telegram row', '100.0', '7.0', 'private', '200.0', 'queued', '[]', 'now');
        PRAGMA user_version = 13;
      `);
      applyMigrations(raw);
      expect(raw.prepare(`SELECT typeof(chat_id) AS chatType, typeof(thread_id) AS threadType, typeof(user_id) AS userType,
        chat_id AS chatId, thread_id AS threadId, user_id AS userId FROM pending_messages`).get()).toEqual({
        chatType: "integer", threadType: "integer", userType: "integer",
        chatId: 100, threadId: 7, userId: 200,
      });
    } finally {
      raw.close();
    }
  });

  it("repairs an already-v13 mixed queue without changing Discord text", () => {
    const raw = new Database(":memory:");
    try {
      raw.exec(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, surface TEXT NOT NULL, chat_key TEXT NOT NULL,
          prompt TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT, chat_type TEXT NOT NULL,
          user_id TEXT, state TEXT NOT NULL, claim_run_id TEXT, claim_acquisition_id TEXT,
          claimed_at TEXT, attachments_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_pending_msgs_surface_chat_key ON pending_messages(surface, chat_key, id);
        INSERT INTO pending_messages(surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, state, attachments_json, created_at)
        VALUES ('discord:interactive', '${DISCORD_18_DIGIT_ID}', 'Discord row', '${DISCORD_18_DIGIT_ID}', '${DISCORD_CHAT_ID}', 'guild', '${DISCORD_CHAT_ID}', 'queued', '[]', 'now');
        PRAGMA user_version = 13;
      `);
      applyMigrations(raw);
      expect(raw.prepare(`SELECT typeof(chat_id) AS chatType, chat_id AS chatId, thread_id AS threadId, user_id AS userId
        FROM pending_messages`).get()).toEqual({
        chatType: "text", chatId: DISCORD_18_DIGIT_ID, threadId: DISCORD_CHAT_ID, userId: DISCORD_CHAT_ID,
      });
    } finally {
      raw.close();
    }
  });
});
