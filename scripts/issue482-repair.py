from pathlib import Path
import sys


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    p = Path(path)
    text = p.read_text()
    start_i = text.find(start)
    if start_i < 0:
        raise SystemExit(f"missing start anchor in {path}: {start!r}")
    end_i = text.find(end, start_i)
    if end_i < 0:
        raise SystemExit(f"missing end anchor in {path}: {end!r}")
    p.write_text(text[:start_i] + replacement + text[end_i:])


def write_red() -> None:
    Path("test/issue482.repair.red.test.ts").write_text(r'''import { expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

it("keeps same-key retained state inside the canonical surface", () => {
  const path = join(tmpdir(), `issue482-repair-red-${Date.now()}.sqlite`);
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
    expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "discord:interactive", chatKey: "42" }, "discord-only")).toHaveLength(1);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
''')


def apply() -> None:
    Path("src/conversationOwnerKey.ts").write_text(r'''/** Mechanically derive a durable owner-search key only for a singleton authorized identity. */
export function deriveConversationOwnerKey(
  surfaceIdentity: string,
  allowedUserIds: ReadonlySet<string>,
): string | null {
  const surface = surfaceIdentity.trim();
  if (!surface || allowedUserIds.size !== 1) return null;
  const ownerId = allowedUserIds.values().next().value?.trim();
  return ownerId ? JSON.stringify([surface, ownerId]) : null;
}
''')

    replace_between(
        "src/repositories/conversationRepository.ts",
        "  getRecentConvTurns(",
        "  // Historical summaries are retained only",
        r'''  getRecentConvTurns(
    chatKey: string,
    limit: number,
    sinceId?: number,
    surfaceIdentity?: string,
  ): ConvTurnRow[] {
    const surface = surfaceIdentity?.trim();
    const scopeSql = surface
      ? "chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)"
      : "chat_key = ?";
    const scopeParams: unknown[] = surface ? [chatKey, surface] : [chatKey];
    if (sinceId != null) {
      return this.db
        .prepare(
          `SELECT id, role, text, cli, created_at FROM (
             SELECT id, role, text, cli, created_at FROM conversation_turns
             WHERE ${scopeSql} AND id > ?
             ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`
        )
        .all(...scopeParams, sinceId, limit) as ConvTurnRow[];
    }
    return this.db
      .prepare(
        `SELECT id, role, text, cli, created_at FROM (
           SELECT id, role, text, cli, created_at FROM conversation_turns
           WHERE ${scopeSql}
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(...scopeParams, limit) as ConvTurnRow[];
  }

  buildConvContext(
    chatKey: string,
    maxChars = DEFAULT_CONTEXT_MAX_CHARS,
    surfaceIdentity?: string,
  ): string {
    const candidates = this.getRecentConvTurns(chatKey, recentTurnCandidateLimit(), undefined, surfaceIdentity);
    if (candidates.length === 0) return "";

    let budget = maxChars;
    const selected: Array<{ role: string; text: string }> = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const t = candidates[i];
      const line = `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`;
      if (line.length <= budget) {
        selected.unshift({ role: t.role, text: t.text });
        budget -= line.length;
      }
    }

    const lines = ["[Context from previous conversation]"];
    for (const t of selected) {
      lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
    }
    lines.push("[End context — continue naturally]");
    return lines.join("\n") + "\n\n";
  }

''')

    replace_once(
        "src/repositories/conversationRepository.ts",
        '''  clearConvHistory(chatKey: string): void {\n    this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);\n    this.db.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);\n  }\n\n  getTurnCount(chatKey: string): number {\n    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`).get(chatKey) as { n: number };\n    return row.n;\n  }\n\n  getLatestTurnAt(chatKey: string): string | null {\n    const row = this.db\n      .prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)\n      .get(chatKey) as { created_at: string } | undefined;\n    return row?.created_at ?? null;\n  }\n\n  getLatestSummaryAt(chatKey: string): string | null {\n    const row = this.db\n      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)\n      .get(chatKey) as { created_at: string } | undefined;\n    return row?.created_at ?? null;\n  }''',
        '''  clearConvHistory(chatKey: string, surfaceIdentity?: string): void {\n    const surface = surfaceIdentity?.trim();\n    if (surface) {\n      this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)`).run(chatKey, surface);\n      // Historical summaries predate canonical surface provenance. A scoped reset\n      // cannot mechanically attribute them, so leave them intact instead of\n      // deleting another surface's compatibility data.\n      return;\n    }\n    this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);\n    this.db.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);\n  }\n\n  getTurnCount(chatKey: string, surfaceIdentity?: string): number {\n    const surface = surfaceIdentity?.trim();\n    const row = surface\n      ? this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)`).get(chatKey, surface) as { n: number }\n      : this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`).get(chatKey) as { n: number };\n    return row.n;\n  }\n\n  getLatestTurnAt(chatKey: string, surfaceIdentity?: string): string | null {\n    const surface = surfaceIdentity?.trim();\n    const row = surface\n      ? this.db.prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL) ORDER BY id DESC LIMIT 1`).get(chatKey, surface) as { created_at: string } | undefined\n      : this.db.prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`).get(chatKey) as { created_at: string } | undefined;\n    return row?.created_at ?? null;\n  }\n\n  getLatestSummaryAt(chatKey: string, surfaceIdentity?: string): string | null {\n    // Historical summaries do not carry canonical surface provenance. Never\n    // expose one through a surface-scoped status query.\n    if (surfaceIdentity?.trim()) return null;\n    const row = this.db\n      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)\n      .get(chatKey) as { created_at: string } | undefined;\n    return row?.created_at ?? null;\n  }''')

    replace_once(
        "src/db.ts",
        '''  getRecentConvTurns(\n    chatKey: string,\n    limit: number,\n    sinceId?: number,\n  ): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {\n    return this.conversations.getRecentConvTurns(chatKey, limit, sinceId);\n  }\n\n  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {\n    return this.conversations.buildConvContext(chatKey, maxChars);\n  }''',
        '''  getRecentConvTurns(\n    chatKey: string,\n    limit: number,\n    sinceId?: number,\n    surfaceIdentity?: string,\n  ): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {\n    return this.conversations.getRecentConvTurns(chatKey, limit, sinceId, surfaceIdentity);\n  }\n\n  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS, surfaceIdentity?: string): string {\n    return this.conversations.buildConvContext(chatKey, maxChars, surfaceIdentity);\n  }''')

    replace_once(
        "src/db.ts",
        '''  clearConvHistory(chatKey: string): void {\n    this.conversations.clearConvHistory(chatKey);\n  }''',
        '''  clearConvHistory(chatKey: string, surfaceIdentity?: string): void {\n    this.conversations.clearConvHistory(chatKey, surfaceIdentity);\n  }''')
    replace_once("src/db.ts", "turnCount: this.conversations.getTurnCount(chatKey),", "turnCount: this.conversations.getTurnCount(chatKey, surface),")
    replace_once("src/db.ts", "latestSummaryAt: this.conversations.getLatestSummaryAt(chatKey),", "latestSummaryAt: this.conversations.getLatestSummaryAt(chatKey, surface),")
    replace_once("src/db.ts", "latestTurnAt: this.conversations.getLatestTurnAt(chatKey),", "latestTurnAt: this.conversations.getLatestTurnAt(chatKey, surface),")

    replace_between(
        "src/contextCommand.ts",
        "function recentTurns(",
        "function searchTurns(",
        r'''function recentTurns(
  db: Database.Database,
  chatKey: string,
  limit: number,
  surfaceIdentity?: string,
): string {
  const rows = new ConversationRepository(db).getRecentConvTurns(chatKey, limit, undefined, surfaceIdentity);
  if (!rows.length) return "No recent conversation turns found.";
  return rows.map((row) => `${row.role === "user" ? "User" : "Assistant"}: ${row.text} (${row.created_at}${row.cli ? ` via ${row.cli}` : ""})`).join("\n");
}
''')
    replace_once(
        "src/contextCommand.ts",
        'if (args.includes("--recent")) return recentTurns(db, chatKey, parseLimit(args, "--recent", 20));',
        'if (args.includes("--recent")) return recentTurns(db, chatKey, parseLimit(args, "--recent", 20), env.AGENT_BRIDGE_SURFACE_IDENTITY?.trim());')

    replace_once("src/engine.ts", 'import { clearHandoffRequired } from "./handoffState.js";', 'import { clearHandoffRequired } from "./handoffState.js";\nimport { deriveConversationOwnerKey } from "./conversationOwnerKey.js";')
    replace_once(
        "src/engine.ts",
        '''  private _conversationOwnerKey(): string | null {\n    if (this.opts.allowedUserIds.size !== 1) return null;\n    const ownerId = this.opts.allowedUserIds.values().next().value?.trim();\n    return ownerId ? JSON.stringify([this.surfaceIdentity, ownerId]) : null;\n  }''',
        '''  private _conversationOwnerKey(): string | null {\n    return deriveConversationOwnerKey(this.surfaceIdentity, this.opts.allowedUserIds);\n  }''')
    replace_once(
        "src/engine.ts",
        "const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS);",
        "const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS, this.surfaceIdentity);")

    replace_once("src/commands.ts", "db.clearConvHistory(chatId);", "db.clearConvHistory(chatId, surfaceIdentity);")

    replace_once("src/index-interactive.ts", 'import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";', 'import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";\nimport { deriveConversationOwnerKey } from "./conversationOwnerKey.js";')
    replace_once(
        "src/index-interactive.ts",
        '''      recordDeliveredAssistantTurn: (chatKey, text) => {\n        db.addConvTurn(chatKey, "assistant", text);\n      },''',
        '''      recordDeliveredAssistantTurn: (chatKey, text) => {\n        const ownerKey = deriveConversationOwnerKey(runtimePolicy.surfaceIdentity, allowedUserIds);\n        db.addConvTurn(chatKey, "assistant", text, undefined, {\n          surfaceIdentity: runtimePolicy.surfaceIdentity,\n          ...(ownerKey ? { ownerKey } : {}),\n        });\n      },''')

    Path("test/retainedConversationScope.test.ts").write_text(r'''import Database from "better-sqlite3";
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
''')


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "red":
        write_red()
    elif mode == "apply":
        apply()
    else:
        raise SystemExit("usage: issue482-repair.py red|apply")
