import type Database from "better-sqlite3";

export const DEFAULT_CONTEXT_MAX_CHARS = 24_000;
export const DEFAULT_CONTEXT_RECENT_TURN_LIMIT = 200;

// Issue #350: bounds for scoped chronological search over conversation_turns.
// Kept intentionally small — search results are inlined directly into
// agent-facing prompt text (contextCommand.ts, handoff guidance), so both
// the result count and the per-turn snippet length must stay prompt-safe
// regardless of how large a match's source turn is.
export const DEFAULT_SEARCH_TURN_LIMIT = 5;
export const MAX_SEARCH_TURN_LIMIT = 20;
export const MAX_SEARCH_CONTEXT_TURNS = 20;
export const MAX_SEARCH_SNIPPET_CHARS = 300;

const SEARCH_STOPWORDS = new Set([
  "about",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "how",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

function recentTurnCandidateLimit(): number {
  const raw = process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  if (!raw) return DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
}

function tokenizeSearchQuery(raw: string): string[] {
  const words = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens = [...new Set(words.filter((word) => word.length > 1))];
  const distinctiveTokens = tokens.filter((token) => !SEARCH_STOPWORDS.has(token));
  return (distinctiveTokens.length > 0 ? distinctiveTokens : tokens).slice(0, 8);
}

// Escapes SQLite LIKE metacharacters (% _ and the escape character itself)
// so search terms are matched literally.
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ConvTurnRow {
  id: number;
  role: string;
  text: string;
  cli: string | null;
  created_at: string;
  /** True when this row was a selected search hit rather than adjacent context. */
  is_match?: boolean;
}

export interface ConvSummaryRow {
  id: number;
  range_start_turn_id: number;
  range_end_turn_id: number;
  summary_md: string;
  created_at: string;
}

/** Connection-bound SQL owner for retained conversation evidence. */
export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {
    this.db
      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli) VALUES (?, ?, ?, ?)`)
      .run(chatKey, role, text, cli ?? null);
  }

  getRecentConvTurns(chatKey: string, limit: number, sinceId?: number): ConvTurnRow[] {
    if (sinceId != null) {
      return this.db
        .prepare(
          `SELECT id, role, text, cli, created_at FROM (
             SELECT id, role, text, cli, created_at FROM conversation_turns
             WHERE chat_key = ? AND id > ?
             ORDER BY id DESC LIMIT ?
           ) ORDER BY id ASC`
        )
        .all(chatKey, sinceId, limit) as ConvTurnRow[];
    }
    return this.db
      .prepare(
        `SELECT id, role, text, cli, created_at FROM (
           SELECT id, role, text, cli, created_at FROM conversation_turns
           WHERE chat_key = ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`
      )
      .all(chatKey, limit) as ConvTurnRow[];
  }

  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS): string {
    const candidates = this.getRecentConvTurns(chatKey, recentTurnCandidateLimit());
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

  // Historical summaries are retained only for non-destructive schema/data
  // compatibility and scoped /reset cleanup. They are not prompt inputs.
  addConvSummary(chatKey: string, startTurnId: number, endTurnId: number, summaryMd: string): void {
    this.db
      .prepare(
        `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
         VALUES (?, ?, ?, ?)`
      )
      .run(chatKey, startTurnId, endTurnId, summaryMd);
  }

  getLatestConvSummary(chatKey: string): ConvSummaryRow | null {
    return (this.db
      .prepare(
        `SELECT id, range_start_turn_id, range_end_turn_id, summary_md, created_at
         FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`
      )
      .get(chatKey) as ConvSummaryRow | undefined) ?? null;
  }

  /**
   * Issue #350: read-only, chat-scoped chronological search over exact
   * conversation turns. Supplements — never replaces — the bounded recent
   * turn window used for fresh-session continuity.
   */
  searchConvTurns(chatKey: string, query: string, limit = DEFAULT_SEARCH_TURN_LIMIT): ConvTurnRow[] {
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_SEARCH_TURN_LIMIT), MAX_SEARCH_TURN_LIMIT);
    const clauses = tokens.map(() => `text LIKE ? ESCAPE '\\'`).join(" OR ");
    const coverage = tokens.map(() => `CASE WHEN text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(" + ");
    const params = tokens.map((t) => `%${escapeLikeTerm(t)}%`);

    const matchingRows = this.db
      .prepare(
        `SELECT id, role, text, cli, created_at FROM conversation_turns
         WHERE chat_key = ? AND (${clauses})
         ORDER BY (${coverage}) DESC, id DESC
         LIMIT ?`
      )
      .all(chatKey, ...params, ...params, boundedLimit) as ConvTurnRow[];

    const evidence = new Map<number, ConvTurnRow>();
    const adjacent = (id: number, direction: "before" | "after"): ConvTurnRow | undefined => {
      const operator = direction === "before" ? "<" : ">";
      const order = direction === "before" ? "DESC" : "ASC";
      return this.db
        .prepare(
          `SELECT id, role, text, cli, created_at FROM conversation_turns
           WHERE chat_key = ? AND id ${operator} ?
           ORDER BY id ${order} LIMIT 1`
        )
        .get(chatKey, id) as ConvTurnRow | undefined;
    };

    for (const hit of matchingRows) {
      const existing = evidence.get(hit.id);
      if (existing) {
        evidence.set(hit.id, { ...existing, is_match: true });
      } else {
        if (evidence.size >= MAX_SEARCH_CONTEXT_TURNS) break;
        evidence.set(hit.id, { ...hit, is_match: true });
      }
      for (const context of [adjacent(hit.id, "before"), adjacent(hit.id, "after")]) {
        if (context && !evidence.has(context.id) && evidence.size < MAX_SEARCH_CONTEXT_TURNS) {
          evidence.set(context.id, { ...context, is_match: false });
        }
      }
    }

    return [...evidence.values()].sort((a, b) => a.id - b.id).map((row) => ({
      ...row,
      text:
        row.text.length > MAX_SEARCH_SNIPPET_CHARS
          ? `${row.text.slice(0, MAX_SEARCH_SNIPPET_CHARS)}…`
          : row.text,
    }));
  }

  clearConvHistory(chatKey: string): void {
    this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);
    this.db.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);
  }

  getTurnCount(chatKey: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`).get(chatKey) as { n: number };
    return row.n;
  }

  getLatestTurnAt(chatKey: string): string | null {
    const row = this.db
      .prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  getLatestSummaryAt(chatKey: string): string | null {
    const row = this.db
      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }
}
