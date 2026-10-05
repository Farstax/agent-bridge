import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyLegacySettingsSurfaceMigration } from "../src/db/legacySettingsSurfaceMigration.js";

function createSettingsTable(db: Database.Database): void {
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
}

function createOutwardAcpSessions(db: Database.Database): void {
  db.exec(`CREATE TABLE outward_acp_sessions (
    session_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    cwd TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
}

function settingsRows(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

describe("legacy settings surface migration (v19)", () => {
  it("migrates a pre-v18 narration preference onto its surface-scoped key", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("antigravity:narration:42", "visible");

      applyLegacySettingsSurfaceMigration(db, "interactive");

      expect(settingsRows(db)).toEqual({
        "antigravity:narration:telegram:interactive:42": "visible",
      });
    } finally {
      db.close();
    }
  });

  it("migrates a pre-v18 handoff marker onto its surface-scoped key, preserving a chat key that itself contains a colon", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      // Telegram topic chat keys are "<chatId>:<threadId>".
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run("handoff_required:-1004366290625:1458:claude", '{"reason":"fallback_from_codex","at":"2026-01-01T00:00:00.000Z"}');

      applyLegacySettingsSurfaceMigration(db, "interactive");

      expect(settingsRows(db)).toEqual({
        "handoff_required:telegram:interactive:-1004366290625:1458:claude": '{"reason":"fallback_from_codex","at":"2026-01-01T00:00:00.000Z"}',
      });
    } finally {
      db.close();
    }
  });

  it("migrates onto discord:interactive for a discord-role database", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("antigravity:narration:channel-1", "hidden");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("handoff_required:channel-1:grok", '{"reason":"manual_switch","at":"2026-01-01T00:00:00.000Z"}');

      applyLegacySettingsSurfaceMigration(db, "discord");

      expect(settingsRows(db)).toEqual({
        "antigravity:narration:discord:interactive:channel-1": "hidden",
        "handoff_required:discord:interactive:channel-1:grok": '{"reason":"manual_switch","at":"2026-01-01T00:00:00.000Z"}',
      });
    } finally {
      db.close();
    }
  });

  it("does not fabricate provenance for a legacy chat key that actually belongs to an outward ACP conversation", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      createOutwardAcpSessions(db);
      db.prepare(`INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)`)
        .run("session-1", "outward-conversation-1", "/tmp");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("antigravity:narration:outward-conversation-1", "visible");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("handoff_required:outward-conversation-1:codex", '{"reason":"manual_switch","at":"2026-01-01T00:00:00.000Z"}');

      applyLegacySettingsSurfaceMigration(db, "interactive");

      // Left under the original key, untouched -- not guessed into telegram:interactive.
      expect(settingsRows(db)).toEqual({
        "antigravity:narration:outward-conversation-1": "visible",
        "handoff_required:outward-conversation-1:codex": '{"reason":"manual_switch","at":"2026-01-01T00:00:00.000Z"}',
      });
    } finally {
      db.close();
    }
  });

  it("is idempotent and does not clobber a live surface-scoped row with stale legacy data on an already-upgraded database", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      // Shape of an already-v18 database: the runtime already wrote the
      // live surface-scoped row after upgrade, but the orphaned pre-v18 row
      // from before #929 shipped was never cleaned up.
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("antigravity:narration:42", "hidden");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("antigravity:narration:telegram:interactive:42", "visible");

      applyLegacySettingsSurfaceMigration(db, "interactive");

      // The live row wins; the stale legacy row is cleaned up rather than
      // left to resurface on a second migration pass.
      expect(settingsRows(db)).toEqual({
        "antigravity:narration:telegram:interactive:42": "visible",
      });

      // Running it again is a no-op.
      applyLegacySettingsSurfaceMigration(db, "interactive");
      expect(settingsRows(db)).toEqual({
        "antigravity:narration:telegram:interactive:42": "visible",
      });
    } finally {
      db.close();
    }
  });

  it("is a no-op for a role-specific database without a settings table", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE health_plugin_reports (plugin_name TEXT PRIMARY KEY)");
      expect(() => applyLegacySettingsSurfaceMigration(db, "health")).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("leaves unrelated settings rows untouched", () => {
    const db = new Database(":memory:");
    try {
      createSettingsTable(db);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("codex", "gpt-5");
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("chat:repo:telegram:interactive:42", "owner/repo");

      applyLegacySettingsSurfaceMigration(db, "interactive");

      expect(settingsRows(db)).toEqual({
        codex: "gpt-5",
        "chat:repo:telegram:interactive:42": "owner/repo",
      });
    } finally {
      db.close();
    }
  });
});
