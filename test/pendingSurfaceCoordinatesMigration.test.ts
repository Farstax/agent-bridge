import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyPendingSurfaceCoordinatesMigration } from "../src/db/pendingSurfaceCoordinatesMigration.js";

describe("pending surface-coordinate migration", () => {
  it("preserves Telegram numbers and repairs/prevents Discord Snowflake coercion", () => {
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
      `);
      const insertBefore = raw.prepare(`
        INSERT INTO pending_messages (
          surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertBefore.run("telegram:interactive", "100", "legacy numeric", 100, 200, "private", 300);

      const chatId = "1234567890123456789";
      const threadId = "2234567890123456789";
      const userId = "3234567890123456789";
      insertBefore.run("discord:interactive", chatId, "pre-migration snowflakes", chatId, threadId, "private", userId);

      expect(raw.prepare(`
        SELECT typeof(chat_id) AS chatIdType, typeof(thread_id) AS threadIdType, typeof(user_id) AS userIdType
        FROM pending_messages WHERE prompt = 'pre-migration snowflakes'
      `).get()).toEqual({ chatIdType: "integer", threadIdType: "integer", userIdType: "integer" });

      applyPendingSurfaceCoordinatesMigration(raw);

      const coordinateTypes = (raw.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string; type: string }>)
        .filter((column) => ["chat_id", "thread_id", "user_id"].includes(column.name))
        .map((column) => [column.name, column.type]);
      expect(coordinateTypes).toEqual([
        ["chat_id", "BLOB"],
        ["thread_id", "BLOB"],
        ["user_id", "BLOB"],
      ]);

      expect(raw.prepare(`
        SELECT chat_id AS chatId, thread_id AS threadId, user_id AS userId
        FROM pending_messages WHERE surface = 'telegram:interactive'
      `).get()).toEqual({ chatId: 100, threadId: 200, userId: 300 });
      expect(raw.prepare(`
        SELECT chat_id AS chatId, thread_id AS threadId, user_id AS userId
        FROM pending_messages WHERE prompt = 'pre-migration snowflakes'
      `).get()).toEqual({ chatId, threadId, userId });

      const insertAfter = raw.prepare(`
        INSERT INTO pending_messages (
          surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertAfter.run("discord:interactive", chatId, "post-migration snowflakes", chatId, threadId, "private", userId);
      expect(raw.prepare(`
        SELECT chat_id AS chatId, thread_id AS threadId, user_id AS userId
        FROM pending_messages WHERE prompt = 'post-migration snowflakes'
      `).get()).toEqual({ chatId, threadId, userId });
    } finally {
      raw.close();
    }
  });
});
