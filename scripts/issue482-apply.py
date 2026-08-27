from pathlib import Path
import sys


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))


def write_red() -> None:
    Path("test/issue482.red.test.ts").write_text(r'''import { expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

it("requires an authorized owner scope to find another conversation", () => {
  const path = join(tmpdir(), `issue482-red-${Date.now()}.sqlite`);
  const db = openDb(path);
  try {
    db.addConvTurn("chat:1", "user", "current conversation", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    db.addConvTurn("chat:2", "user", "cross conversation evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    const output = renderAgentBridgeContext(["--search", "cross conversation", "--scope", "owner"], {
      AGENT_BRIDGE_CONTEXT_DB: path,
      AGENT_BRIDGE_CHAT_KEY: "chat:1",
      AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
      AGENT_BRIDGE_OWNER_KEY: "owner-a",
    });
    expect(output).toContain("cross conversation evidence");
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
''')


def apply() -> None:
    Path("src/db/conversationScopeMigration.ts").write_text('''import type Database from "better-sqlite3";

/** Adds durable canonical conversation provenance used by authorized history search. */
export function applyConversationScopeMigration(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(conversation_turns)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("surface_identity")) db.exec("ALTER TABLE conversation_turns ADD COLUMN surface_identity TEXT");
  if (!columns.has("owner_key")) db.exec("ALTER TABLE conversation_turns ADD COLUMN owner_key TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_turns_conversation_scope
      ON conversation_turns(surface_identity, chat_key, id);
    CREATE INDEX IF NOT EXISTS idx_conv_turns_owner_scope
      ON conversation_turns(owner_key, id);
  `);
}
''')

    replace("src/db/schema.ts",
        'import { applyCursorSessionColumnsMigration } from "./cursorSessionColumnsMigration.js";\n',
        'import { applyCursorSessionColumnsMigration } from "./cursorSessionColumnsMigration.js";\nimport { applyConversationScopeMigration } from "./conversationScopeMigration.js";\n')
    replace("src/db/schema.ts", "export const CURRENT_SCHEMA_VERSION = 11;", "export const CURRENT_SCHEMA_VERSION = 12;")
    replace("src/db/schema.ts",
        " * Version 11 adds Cursor session identity and failure columns.\n",
        " * Version 11 adds Cursor session identity and failure columns.\n * Version 12 adds canonical conversation provenance for authorized cross-conversation search.\n")
    replace("src/db/schema.ts",
        '  { version: 11, name: "add-cursor-session-columns", up: applyCursorSessionColumnsMigration },\n];',
        '  { version: 11, name: "add-cursor-session-columns", up: applyCursorSessionColumnsMigration },\n  { version: 12, name: "add-conversation-search-scope", up: applyConversationScopeMigration },\n];')

    replace("src/repositories/conversationRepository.ts",
        'export interface ConvTurnRow {\n  id: number;\n  role: string;\n  text: string;\n  cli: string | null;\n  created_at: string;\n',
        'export interface ConversationTurnProvenance {\n  surfaceIdentity: string;\n  ownerKey?: string;\n}\n\nexport type AuthorizedConversationSearchScope =\n  | { scope: "conversation"; surfaceIdentity: string; chatKey: string }\n  | { scope: "owner"; ownerKey: string };\n\nexport interface ConvTurnRow {\n  id: number;\n  role: string;\n  text: string;\n  cli: string | null;\n  created_at: string;\n  chat_key?: string;\n  surface_identity?: string | null;\n  owner_key?: string | null;\n')
    replace("src/repositories/conversationRepository.ts",
        '  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {\n    this.db\n      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli) VALUES (?, ?, ?, ?)`)\n      .run(chatKey, role, text, cli ?? null);\n  }',
        '  addConvTurn(\n    chatKey: string,\n    role: "user" | "assistant",\n    text: string,\n    cli?: string,\n    provenance?: ConversationTurnProvenance,\n  ): void {\n    this.db\n      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli, surface_identity, owner_key) VALUES (?, ?, ?, ?, ?, ?)`)\n      .run(chatKey, role, text, cli ?? null, provenance?.surfaceIdentity ?? null, provenance?.ownerKey ?? null);\n  }')

    repo = Path("src/repositories/conversationRepository.ts")
    s = repo.read_text()
    start = s.index('  /**\n   * Issue #350: read-only, chat-scoped chronological search over exact')
    end = s.index('  clearConvHistory(chatKey: string): void {', start)
    replacement = r'''  /** Issue #350 legacy chat-key search retained for compatibility. */
  searchConvTurns(chatKey: string, query: string, limit = DEFAULT_SEARCH_TURN_LIMIT): ConvTurnRow[] {
    return this.searchConvTurnsWhere("chat_key = ?", [chatKey], query, limit);
  }

  /**
   * Explicit authorized search. Conversation is the default canonical scope;
   * owner scope requires a mechanically issued owner key. Legacy rows without
   * surface provenance remain visible only to conversation scope.
   */
  searchAuthorizedConvTurns(
    scope: AuthorizedConversationSearchScope,
    query: string,
    limit = DEFAULT_SEARCH_TURN_LIMIT,
  ): ConvTurnRow[] {
    if (scope.scope === "owner") {
      if (!scope.ownerKey.trim()) return [];
      return this.searchConvTurnsWhere("owner_key = ?", [scope.ownerKey], query, limit);
    }
    if (!scope.surfaceIdentity.trim() || !scope.chatKey.trim()) return [];
    return this.searchConvTurnsWhere(
      "chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)",
      [scope.chatKey, scope.surfaceIdentity],
      query,
      limit,
    );
  }

  private searchConvTurnsWhere(
    scopeSql: string,
    scopeParams: unknown[],
    query: string,
    limit: number,
  ): ConvTurnRow[] {
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_SEARCH_TURN_LIMIT), MAX_SEARCH_TURN_LIMIT);
    const clauses = tokens.map(() => `text LIKE ? ESCAPE '\\'`).join(" OR ");
    const coverage = tokens.map(() => `CASE WHEN text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(" + ");
    const params = tokens.map((t) => `%${escapeLikeTerm(t)}%`);

    const matchingRows = this.db
      .prepare(
        `SELECT id, chat_key, surface_identity, owner_key, role, text, cli, created_at FROM conversation_turns
         WHERE (${scopeSql}) AND (${clauses})
         ORDER BY (${coverage}) DESC, id DESC
         LIMIT ?`
      )
      .all(...scopeParams, ...params, ...params, boundedLimit) as ConvTurnRow[];

    const evidence = new Map<number, ConvTurnRow>();
    const adjacent = (hit: ConvTurnRow, direction: "before" | "after"): ConvTurnRow | undefined => {
      const operator = direction === "before" ? "<" : ">";
      const order = direction === "before" ? "DESC" : "ASC";
      const surfaceClause = hit.surface_identity == null ? "surface_identity IS NULL" : "surface_identity = ?";
      const ownerClause = hit.owner_key == null ? "owner_key IS NULL" : "owner_key = ?";
      const originParams: unknown[] = [hit.chat_key];
      if (hit.surface_identity != null) originParams.push(hit.surface_identity);
      if (hit.owner_key != null) originParams.push(hit.owner_key);
      originParams.push(hit.id);
      return this.db
        .prepare(
          `SELECT id, chat_key, surface_identity, owner_key, role, text, cli, created_at FROM conversation_turns
           WHERE chat_key = ? AND ${surfaceClause} AND ${ownerClause} AND id ${operator} ?
           ORDER BY id ${order} LIMIT 1`
        )
        .get(...originParams) as ConvTurnRow | undefined;
    };

    for (const hit of matchingRows) {
      const existing = evidence.get(hit.id);
      if (existing) {
        evidence.set(hit.id, { ...existing, is_match: true });
      } else {
        if (evidence.size >= MAX_SEARCH_CONTEXT_TURNS) break;
        evidence.set(hit.id, { ...hit, is_match: true });
      }
      for (const context of [adjacent(hit, "before"), adjacent(hit, "after")]) {
        if (context && !evidence.has(context.id) && evidence.size < MAX_SEARCH_CONTEXT_TURNS) {
          evidence.set(context.id, { ...context, is_match: false });
        }
      }
    }

    return [...evidence.values()].sort((a, b) => a.id - b.id).map((row) => ({
      ...row,
      text: row.text.length > MAX_SEARCH_SNIPPET_CHARS
        ? `${row.text.slice(0, MAX_SEARCH_SNIPPET_CHARS)}…`
        : row.text,
    }));
  }

'''
    repo.write_text(s[:start] + replacement + s[end:])

    replace("src/db.ts",
        'import { ConversationRepository, DEFAULT_CONTEXT_MAX_CHARS } from "./repositories/conversationRepository.js";',
        'import { ConversationRepository, DEFAULT_CONTEXT_MAX_CHARS, type AuthorizedConversationSearchScope, type ConversationTurnProvenance } from "./repositories/conversationRepository.js";')
    replace("src/db.ts",
        '  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {\n    this.conversations.addConvTurn(chatKey, role, text, cli);\n  }',
        '  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string, provenance?: ConversationTurnProvenance): void {\n    this.conversations.addConvTurn(chatKey, role, text, cli, provenance);\n  }')
    replace("src/db.ts",
        '  /** Issue #350 — scoped exact-turn search. */\n  searchConvTurns(chatKey: string, query: string, limit?: number): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {\n    return this.conversations.searchConvTurns(chatKey, query, limit);\n  }',
        '  /** Issue #350 — legacy chat-key exact-turn search. */\n  searchConvTurns(chatKey: string, query: string, limit?: number) {\n    return this.conversations.searchConvTurns(chatKey, query, limit);\n  }\n\n  /** Explicit mechanically authorized exact-turn search. */\n  searchAuthorizedConvTurns(scope: AuthorizedConversationSearchScope, query: string, limit?: number) {\n    return this.conversations.searchAuthorizedConvTurns(scope, query, limit);\n  }')

    Path("src/contextCommand.ts").write_text(r'''/**
 * PURPOSE: Read-only helper for agents to inspect retained Agent Bridge conversation turns.
 * INPUTS: AGENT_BRIDGE_CONTEXT_DB, AGENT_BRIDGE_CHAT_KEY, canonical surface/owner env, and CLI args.
 * OUTPUTS: Recent exact turns or explicitly authorized chronological search.
 * NEIGHBORS: src/engine.ts, bin/agent-bridge-context
 */

import Database from "better-sqlite3";
import { ConversationRepository, type ConvTurnRow } from "./repositories/conversationRepository.js";

type EnvLike = Record<string, string | undefined>;
type SearchScope = "conversation" | "owner";
export const MAX_SEARCH_OUTPUT_CHARS = 4_000;
const MAX_SEARCH_QUERY_CHARS = 240;

function normalizeSearchQuery(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_QUERY_CHARS);
}
function requireEnv(env: EnvLike, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function parseLimit(args: string[], flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = Number(args[idx + 1]);
  if (!Number.isInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, 100);
}
function parseSearchScope(args: string[]): SearchScope {
  const idx = args.indexOf("--scope");
  if (idx === -1) return "conversation";
  const scope = args[idx + 1];
  if (scope === "conversation" || scope === "owner") return scope;
  throw new Error('--scope must be "conversation" or "owner"');
}
function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
function recentTurns(db: Database.Database, chatKey: string, limit: number): string {
  const rows = db.prepare(
    `SELECT role, text, cli, created_at FROM (
       SELECT id, role, text, cli, created_at FROM conversation_turns
       WHERE chat_key = ? ORDER BY id DESC LIMIT ?
     ) ORDER BY id ASC`,
  ).all(chatKey, limit) as Array<{ role: string; text: string; cli: string | null; created_at: string }>;
  if (!rows.length) return "No recent conversation turns found.";
  return rows.map((row) => `${row.role === "user" ? "User" : "Assistant"}: ${row.text} (${row.created_at}${row.cli ? ` via ${row.cli}` : ""})`).join("\n");
}
function searchTurns(db: Database.Database, chatKey: string, query: string, args: string[], env: EnvLike): string {
  const trimmed = normalizeSearchQuery(query);
  if (!trimmed) return "No conversation turns found for that query.";
  const scope = parseSearchScope(args);
  const repository = new ConversationRepository(db);
  let rows: ConvTurnRow[];
  if (scope === "owner") {
    const ownerKey = env.AGENT_BRIDGE_OWNER_KEY?.trim();
    if (!ownerKey) return "Owner-wide search is unavailable: this runtime cannot mechanically prove one authenticated owner.";
    rows = repository.searchAuthorizedConvTurns({ scope: "owner", ownerKey }, trimmed);
  } else {
    const surfaceIdentity = env.AGENT_BRIDGE_SURFACE_IDENTITY?.trim();
    rows = surfaceIdentity
      ? repository.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity, chatKey }, trimmed)
      : repository.searchConvTurns(chatKey, trimmed);
  }
  if (!rows.length) return "No conversation turns found matching that query.";
  const renderRows = (selectedRows: ConvTurnRow[]): string => selectedRows.map((r) => {
    const label = r.role === "user" ? "User" : "Assistant";
    const cli = r.cli ? ` via ${r.cli}` : "";
    const provenance = scope === "owner" ? ` [${r.surface_identity ?? "legacy"} ${r.chat_key ?? "unknown"}]` : "";
    return `#${r.id}${provenance} ${label}${cli} (${r.created_at}): ${r.text}`;
  }).join("\n");
  const header = (count: number): string => `${scope === "owner" ? "Authorized owner" : "Conversation"} turns matching "${trimmed}" (${count}, chronological):`;
  const rendered = `${header(rows.length)}\n${renderRows(rows)}`;
  if (rendered.length <= MAX_SEARCH_OUTPUT_CHARS) return rendered;
  const matches = rows.filter((row) => row.is_match);
  const matchesOnly = `${header(matches.length)}\n${renderRows(matches)}`;
  if (matchesOnly.length <= MAX_SEARCH_OUTPUT_CHARS) return matchesOnly;
  const omittedMarker = "\n…[older selected matches omitted]";
  const prefix = `${header(matches.length)}\n`;
  const rowBudget = MAX_SEARCH_OUTPUT_CHARS - prefix.length - omittedMarker.length;
  const newestRows: ConvTurnRow[] = [];
  let used = 0;
  for (let i = matches.length - 1; i >= 0; i--) {
    const line = renderRows([matches[i]]);
    if (used + line.length + (newestRows.length ? 1 : 0) > rowBudget) break;
    newestRows.unshift(matches[i]);
    used += line.length + (newestRows.length > 1 ? 1 : 0);
  }
  return `${prefix}${renderRows(newestRows)}${omittedMarker}`;
}
export function renderAgentBridgeContext(args: string[], env: EnvLike = process.env): string {
  const dbPath = requireEnv(env, "AGENT_BRIDGE_CONTEXT_DB");
  const chatKey = requireEnv(env, "AGENT_BRIDGE_CHAT_KEY");
  const db = openReadonly(dbPath);
  try {
    if (args.includes("--search")) {
      const idx = args.indexOf("--search");
      return searchTurns(db, chatKey, args[idx + 1] ?? "", args, env);
    }
    if (args.includes("--recent")) return recentTurns(db, chatKey, parseLimit(args, "--recent", 20));
    return [
      "Agent Bridge context exposes retained conversation turns only.",
      'Use --recent 20 or --search "<terms>".',
      'Use --search "<terms>" --scope owner only when owner-wide search is available.',
    ].join("\n");
  } finally {
    db.close();
  }
}
''')

    replace("src/engine.ts",
        '  private _rememberTurn(chatKey: string, userPrompt: string, assistantText: string): void {\n    this.db.addConvTurn(chatKey, "user", trimTurnText(userPrompt), this.kind);\n    this.db.addConvTurn(chatKey, "assistant", trimTurnText(assistantText), this.kind);\n  }',
        '  private _conversationOwnerKey(): string | null {\n    if (this.opts.allowedUserIds.size !== 1) return null;\n    const ownerId = this.opts.allowedUserIds.values().next().value?.trim();\n    return ownerId ? JSON.stringify([this.surfaceIdentity, ownerId]) : null;\n  }\n\n  private _rememberTurn(chatKey: string, userPrompt: string, assistantText: string): void {\n    const ownerKey = this._conversationOwnerKey();\n    const provenance = { surfaceIdentity: this.surfaceIdentity, ...(ownerKey ? { ownerKey } : {}) };\n    this.db.addConvTurn(chatKey, "user", trimTurnText(userPrompt), this.kind, provenance);\n    this.db.addConvTurn(chatKey, "assistant", trimTurnText(assistantText), this.kind, provenance);\n  }')
    replace("src/engine.ts",
        '    const contextPrompt = hasContext ? [\n      "[Agent Bridge context]",\n      "More retained conversation turns are available if needed:",\n      \'"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20\',\n      \'"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"\',\n      "",\n    ].join("\\n") : "";',
        '    const ownerKey = this._conversationOwnerKey();\n    const contextPrompt = hasContext ? [\n      "[Agent Bridge context]",\n      "More retained conversation turns are available if needed:",\n      \'"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20\',\n      \'"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"\',\n      ...(ownerKey ? [\'"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>" --scope owner\'] : []),\n      "",\n    ].join("\\n") : "";')
    replace("src/engine.ts",
        '          AGENT_BRIDGE_CONTEXT_DB: dbPath!,\n          AGENT_BRIDGE_CHAT_KEY: chatKey,\n',
        '          AGENT_BRIDGE_CONTEXT_DB: dbPath!,\n          AGENT_BRIDGE_CHAT_KEY: chatKey,\n          AGENT_BRIDGE_SURFACE_IDENTITY: this.surfaceIdentity,\n          ...(ownerKey ? { AGENT_BRIDGE_OWNER_KEY: ownerKey } : {}),\n')

    p = Path("test/conversationStore.test.ts")
    s = p.read_text()
    marker = '\ndescribe("pending messages", () => {'
    addition = r'''

describe("authorized conversation search", () => {
  it("finds another conversation only through the same mechanically authorized owner scope", () => {
    const ownerA = "owner-a";
    db.addConvTurn("chat:1", "user", "current conversation evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: ownerA });
    db.addConvTurn("chat:2", "user", "authorized remote evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: ownerA });
    db.addConvTurn("chat:3", "user", "unauthorized remote evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-b" });
    const rows = db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: ownerA }, "remote evidence");
    expect(rows.filter((row) => row.is_match).map((row) => row.text)).toEqual(["authorized remote evidence"]);
  });

  it("keeps adjacency inside each originating canonical conversation", () => {
    db.addConvTurn("same-native-id", "assistant", "telegram before", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    db.addConvTurn("same-native-id", "user", "decision marker telegram", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    db.addConvTurn("same-native-id", "assistant", "telegram after", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    db.addConvTurn("same-native-id", "assistant", "discord neighbor must not leak", "codex", { surfaceIdentity: "discord:interactive", ownerKey: "owner-b" });
    const rows = db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "same-native-id" }, "decision marker");
    expect(rows.map((row) => row.text)).toEqual(["telegram before", "decision marker telegram", "telegram after"]);
  });

  it("keeps legacy rows searchable only from conversation scope after migration", () => {
    db.addConvTurn("legacy-chat", "user", "legacy retained evidence", "codex");
    expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "legacy-chat" }, "legacy retained").some((row) => row.text === "legacy retained evidence")).toBe(true);
    expect(db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: "owner-a" }, "legacy retained")).toEqual([]);
  });
});
'''
    if marker not in s:
        raise SystemExit("conversationStore insertion marker missing")
    p.write_text(s.replace(marker, addition + marker, 1))

    p = Path("test/contextCommand.test.ts")
    s = p.read_text()
    insert = r'''

    it("uses conversation scope by default and explicit owner scope for authorized cross-conversation evidence", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "local deployment note", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("chat:2", "assistant", "remote deployment decision Friday", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("chat:3", "assistant", "remote deployment decision Saturday SECRET", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-b" });
        const env = { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "chat:1", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive", AGENT_BRIDGE_OWNER_KEY: "owner-a" };
        const local = renderAgentBridgeContext(["--search", "remote deployment"], env);
        expect(local).not.toContain("Friday");
        const owner = renderAgentBridgeContext(["--search", "remote deployment", "--scope", "owner"], env);
        expect(owner).toContain("Friday");
        expect(owner).not.toContain("SECRET");
        expect(owner).toContain("telegram:interactive chat:2");
      } finally { db.close(); rmSync(path, { force: true }); }
    });

    it("fails owner scope closed when the runtime cannot prove one owner", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        const output = renderAgentBridgeContext(["--search", "evidence", "--scope", "owner"], { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "chat:1", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive" });
        expect(output).toContain("cannot mechanically prove one authenticated owner");
      } finally { db.close(); rmSync(path, { force: true }); }
    });

    it("preserves cross-conversation correction chronology and source provenance", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("topic:old", "user", "release decision is Thursday", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("thread:new", "assistant", "correction release decision is Friday", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        const output = renderAgentBridgeContext(["--search", "release decision", "--scope", "owner"], { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "topic:old", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive", AGENT_BRIDGE_OWNER_KEY: "owner-a" });
        expect(output.indexOf("Thursday")).toBeLessThan(output.indexOf("Friday"));
        expect(output).toContain("topic:old");
        expect(output).toContain("thread:new");
      } finally { db.close(); rmSync(path, { force: true }); }
    });
'''
    anchor = '\n  });\n});\n'
    idx = s.rfind(anchor)
    if idx < 0:
        raise SystemExit("contextCommand insertion marker missing")
    p.write_text(s[:idx] + insert + s[idx:])

    p = Path("test/canonicalConversationIdentity.test.ts")
    s = p.read_text()
    anchor = '\n  it("recovers a queued Discord conversation from its durable native key after database reopen"'
    addition = r'''

  it("keeps retained turn search isolated when different surfaces share the same native chat id", () => {
    const db = openDb(":memory:", { serviceId: "canonical-turn-search-test" });
    try {
      db.addConvTurn("42", "user", "telegram marker", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "telegram-owner" });
      db.addConvTurn("42", "user", "discord marker", "codex", { surfaceIdentity: "discord:interactive", ownerKey: "discord-owner" });
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "42" }, "marker").filter((row) => row.is_match).map((row) => row.text)).toEqual(["telegram marker"]);
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "discord:interactive", chatKey: "42" }, "marker").filter((row) => row.is_match).map((row) => row.text)).toEqual(["discord marker"]);
    } finally { db.close(); }
  });
'''
    if anchor not in s:
        raise SystemExit("canonical identity insertion marker missing")
    p.write_text(s.replace(anchor, addition + anchor, 1))

    docs = Path("docs/operations/retained-conversation-turns.md")
    if docs.exists():
        docs.write_text(docs.read_text() + '''\n\n## Explicit cross-conversation search\n\nSearch stays conversation-scoped by default. When the runtime has exactly one authenticated owner, it exposes an explicit `--scope owner` search. Owner scope is derived by the runtime from the authenticated surface allowlist, not accepted from prompt text, and matches only turns written with that durable owner key. Results retain their canonical surface, conversation key, timestamp, and adjacent exact turns. Legacy pre-migration rows remain available to conversation scope but are never widened into owner scope. Project scope is intentionally not implemented until Agent Bridge has a concrete project identity.\n''')


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in {"red", "apply"}:
        raise SystemExit("usage: issue482-apply.py red|apply")
    write_red() if sys.argv[1] == "red" else apply()
