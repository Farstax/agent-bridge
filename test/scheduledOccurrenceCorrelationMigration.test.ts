import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrationsUpTo } from "../src/db/schema.js";
import { applyScheduledOccurrenceCorrelationMigration } from "../src/db/scheduledOccurrenceCorrelationMigration.js";

describe("scheduled occurrence correlation migration", () => {
  it("adds a nullable correlation key without rewriting queued transport identities", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      surface TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      chat_id BLOB NOT NULL,
      thread_id BLOB,
      chat_type TEXT NOT NULL,
      user_id BLOB,
      state TEXT NOT NULL DEFAULT 'queued',
      claim_run_id TEXT,
      claim_acquisition_id TEXT,
      claimed_at TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );`);
    const snowflake = "1234567890123456789";
    db.prepare(`INSERT INTO pending_messages
      (surface,chat_key,prompt,chat_id,thread_id,chat_type,user_id,created_at)
      VALUES ('discord:interactive','c','p',?,?, 'private',?, '2026-09-01T00:00:00.000Z')`).run(snowflake, snowflake, snowflake);
    applyScheduledOccurrenceCorrelationMigration(db);
    const columns = db.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("scheduled_occurrence_key");
    const row = db.prepare("SELECT typeof(chat_id) AS type, chat_id, scheduled_occurrence_key FROM pending_messages").get() as any;
    expect(row).toEqual({ type: "text", chat_id: snowflake, scheduled_occurrence_key: null });
    db.close();
  });

  it("is a no-op for role databases without pending_messages", () => {
    const db = new Database(":memory:");
    expect(() => applyScheduledOccurrenceCorrelationMigration(db)).not.toThrow();
    db.close();
  });
});
