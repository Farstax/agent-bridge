import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import { applyConversationScopeMigration } from "../src/db/conversationScopeMigration.js";
import { deriveConversationOwnerKey } from "../src/conversationOwnerKey.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

function tempPath(label: string): string {
  return join(tmpdir(), `issue482-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

describe("authorized retained conversation scope", () => {
  it("keeps recent, automatic context, status, and clear inside the canonical surface", () => {
    const path = tempPath("canonical");
    const db = openDb(path);
    try {
      db.addConvTurn("42", "user", "telegram-only", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "tg-owner" });
      db.addConvTurn("42", "user", "discord-only", "codex", { surfaceIdentity: "discord:interactive", ownerKey: "dc-owner" });

      const recent = renderAgentBridgeContext(["--recent", "20"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "42",
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
      });
      expect(recent).toContain("telegram-only");
      expect(recent).not.toContain("discord-only");

      const context = db.buildConvContext("42", 24_000, "telegram:interactive");
      expect(context).toContain("telegram-only");
      expect(context).not.toContain("discord-only");
      expect(db.getConvStatus("42", "telegram:interactive").turnCount).toBe(1);

      db.clearConvHistory("42", "telegram:interactive");
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "42" }, "telegram-only")).toHaveLength(0);
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "discord:interactive", chatKey: "42" }, "discord-only")).toHaveLength(1);
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("preserves authorized owner search and provenance across a database restart", () => {
    const path = tempPath("restart");
    const ownerKey = deriveConversationOwnerKey("telegram:interactive", new Set(["123"]));
    expect(ownerKey).toBeTruthy();
    let db = openDb(path);
    db.addConvTurn("private:42", "user", "before restart", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: ownerKey! });
    db.addConvTurn("-100:1458", "assistant", "after correction", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: ownerKey! });
    db.close();

    try {
      db = openDb(path);
      const rows = db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: ownerKey! }, "restart correction");
      expect(rows.map((row) => row.text)).toEqual(expect.arrayContaining(["before restart", "after correction"]));
      expect(rows.every((row) => row.surface_identity === "telegram:interactive")).toBe(true);
      expect(rows.map((row) => row.chat_key)).toEqual(expect.arrayContaining(["private:42", "-100:1458"]));
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("keeps owner authorization surface-specific and fails closed for multiple owners", () => {
    const telegramOwner = deriveConversationOwnerKey("telegram:interactive", new Set(["7"]));
    const discordOwner = deriveConversationOwnerKey("discord:interactive", new Set(["7"]));
    expect(telegramOwner).not.toBe(discordOwner);
    expect(deriveConversationOwnerKey("telegram:interactive", new Set(["7", "8"]))).toBeNull();
    expect(deriveConversationOwnerKey("", new Set(["7"]))).toBeNull();

    const db = openDb(":memory:");
    db.addConvTurn("42", "user", "telegram private", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: telegramOwner! });
    db.addConvTurn("-100:1458", "user", "telegram topic", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: telegramOwner! });
    db.addConvTurn("42", "user", "discord dm", "codex", { surfaceIdentity: "discord:interactive", ownerKey: discordOwner! });
    db.addConvTurn("channel-9", "user", "discord channel", "codex", { surfaceIdentity: "discord:interactive", ownerKey: discordOwner! });
    db.addConvTurn("thread-10", "user", "discord thread", "codex", { surfaceIdentity: "discord:interactive", ownerKey: discordOwner! });

    const telegramRows = db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: telegramOwner! }, "telegram");
    expect(telegramRows.map((row) => row.chat_key)).toEqual(expect.arrayContaining(["42", "-100:1458"]));
    expect(telegramRows.some((row) => row.surface_identity === "discord:interactive")).toBe(false);
    const discordRows = db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: discordOwner! }, "discord");
    expect(discordRows.map((row) => row.chat_key)).toEqual(expect.arrayContaining(["42", "channel-9", "thread-10"]));
    expect(discordRows.some((row) => row.surface_identity === "telegram:interactive")).toBe(false);
    db.close();
  });

  it("keeps legacy null-provenance rows conversation-visible but out of owner scope", () => {
    const db = openDb(":memory:");
    db.addConvTurn("legacy", "user", "legacy evidence", "codex");
    expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "legacy" }, "legacy evidence")).toHaveLength(1);
    expect(db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: "owner" }, "legacy evidence")).toHaveLength(0);
    db.close();
  });

  it("migrates the conversation turn table and indexes to schema v12", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(12);
    const raw = new Database(":memory:");
    raw.exec(`CREATE TABLE conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_key TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      cli TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    applyConversationScopeMigration(raw);
    const columns = (raw.prepare("PRAGMA table_info(conversation_turns)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining(["surface_identity", "owner_key"]));
    const indexes = (raw.prepare("PRAGMA index_list(conversation_turns)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["idx_conv_turns_conversation_scope", "idx_conv_turns_owner_scope"]));
    raw.close();
  });
});
