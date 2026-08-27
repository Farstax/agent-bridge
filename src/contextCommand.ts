/**
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
function recentTurns(
  db: Database.Database,
  chatKey: string,
  limit: number,
  surfaceIdentity?: string,
): string {
  const rows = new ConversationRepository(db).getRecentConvTurns(chatKey, limit, undefined, surfaceIdentity);
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
    if (args.includes("--recent")) return recentTurns(db, chatKey, parseLimit(args, "--recent", 20), env.AGENT_BRIDGE_SURFACE_IDENTITY?.trim());
    return [
      "Agent Bridge context exposes retained conversation turns only.",
      'Use --recent 20 or --search "<terms>".',
      'Use --search "<terms>" --scope owner only when owner-wide search is available.',
    ].join("\n");
  } finally {
    db.close();
  }
}
