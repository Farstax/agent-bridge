/**
 * PURPOSE: Read-only helper for agents to inspect retained Agent Bridge conversation turns.
 * INPUTS: AGENT_BRIDGE_CONTEXT_DB, AGENT_BRIDGE_CHAT_KEY, and CLI args.
 * OUTPUTS: Recent exact turns or scoped chronological search over older turns.
 * NEIGHBORS: src/engine.ts, bin/agent-bridge-context
 */

import Database from "better-sqlite3";
import { ConversationRepository } from "./repositories/conversationRepository.js";

type EnvLike = Record<string, string | undefined>;

export const MAX_SEARCH_OUTPUT_CHARS = 4_000;
const MAX_SEARCH_QUERY_CHARS = 240;

function normalizeSearchQuery(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_QUERY_CHARS);
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

function openReadonly(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function recentTurns(db: Database.Database, chatKey: string, limit: number): string {
  // arch-lint-allow-legacy-sql: read-only helper predates repository extraction.
  const rows = db.prepare(
    `SELECT role, text, cli, created_at
     FROM (
       SELECT id, role, text, cli, created_at
       FROM conversation_turns
       WHERE chat_key = ?
       ORDER BY id DESC
       LIMIT ?
     )
     ORDER BY id ASC`,
  ).all(chatKey, limit) as Array<{ role: string; text: string; cli: string | null; created_at: string }>;

  if (!rows.length) return "No recent conversation turns found.";
  return rows.map((row) => {
    const label = row.role === "user" ? "User" : "Assistant";
    const cli = row.cli ? ` via ${row.cli}` : "";
    return `${label}: ${row.text} (${row.created_at}${cli})`;
  }).join("\n");
}

// Issue #350: read-only, chat-scoped chronological search over
// conversation_turns. This supplements the bounded recent-turn window and is
// the supported retrieval path for older conversational evidence.
function searchTurns(db: Database.Database, chatKey: string, query: string): string {
  const trimmed = normalizeSearchQuery(query);
  if (!trimmed) return "No conversation turns found for that query.";
  const rows = new ConversationRepository(db).searchConvTurns(chatKey, trimmed);
  if (!rows.length) return "No conversation turns found matching that query.";
  const renderRows = (selectedRows: typeof rows): string => selectedRows.map((r) => {
    const label = r.role === "user" ? "User" : "Assistant";
    const cli = r.cli ? ` via ${r.cli}` : "";
    return `#${r.id} ${label}${cli} (${r.created_at}): ${r.text}`;
  }).join("\n");
  const header = (count: number): string => `Conversation turns matching "${trimmed}" (${count}, chronological):`;
  const rendered = `${header(rows.length)}\n${renderRows(rows)}`;
  if (rendered.length <= MAX_SEARCH_OUTPUT_CHARS) return rendered;

  const matches = rows.filter((row) => row.is_match);
  const matchesOnly = `${header(matches.length)}\n${renderRows(matches)}`;
  if (matchesOnly.length <= MAX_SEARCH_OUTPUT_CHARS) return matchesOnly;

  const omittedMarker = "\n…[older selected matches omitted]";
  const prefix = `${header(matches.length)}\n`;
  const rowBudget = MAX_SEARCH_OUTPUT_CHARS - prefix.length - omittedMarker.length;
  const newestRows: typeof rows = [];
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
      return searchTurns(db, chatKey, args[idx + 1] ?? "");
    }
    if (args.includes("--recent")) {
      return recentTurns(db, chatKey, parseLimit(args, "--recent", 20));
    }
    return [
      "Agent Bridge context exposes retained conversation turns only.",
      'Use --recent 20 or --search "<terms>".',
    ].join("\n");
  } finally {
    db.close();
  }
}
