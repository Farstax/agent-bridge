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
  const tokens = [...new Set(
    raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  )];
  const distinctiveTokens = tokens.filter((token) => !SEARCH_STOPWORDS.has(token));
  return (distinctiveTokens.length > 0 ? distinctiveTokens : tokens).slice(0, 8);
}

// Escapes SQLite LIKE metacharacters (% _ and the escape character itself)
// so search terms are matched literally.
function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface ConversationTurnProvenance {
  surfaceIdentity: string;
  ownerKey?: string;
}

export type AuthorizedConversationSearchScope =
  | { scope: "conversation"; surfaceIdentity: string; chatKey: string }
  | { scope: "owner"; ownerKey: string };

export interface ConvTurnRow {
  id: number;
  role: string;
  text: string;
  cli: string | null;
  created_at: string;
  chat_key?: string;
  surface_identity?: string | null;
  owner_key?: string | null;
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

  addConvTurn(
    chatKey: string,
    role: "user" | "assistant",
    text: string,
    cli?: string,
    provenance?: ConversationTurnProvenance,
  ): void {
    this.db
      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli, surface_identity, owner_key) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chatKey, role, text, cli ?? null, provenance?.surfaceIdentity ?? null, provenance?.ownerKey ?? null);
  }

  getRecentConvTurns(
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

  /** Issue #350 legacy chat-key search retained for compatibility. */
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

  clearConvHistory(chatKey: string, surfaceIdentity?: string): void {
    const surface = surfaceIdentity?.trim();
    if (surface) {
      this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)`).run(chatKey, surface);
      // Historical summaries predate canonical surface provenance. A scoped reset
      // cannot mechanically attribute them, so leave them intact instead of
      // deleting another surface's compatibility data.
      return;
    }
    this.db.prepare(`DELETE FROM conversation_turns WHERE chat_key = ?`).run(chatKey);
    this.db.prepare(`DELETE FROM conversation_summaries WHERE chat_key = ?`).run(chatKey);
  }

  getTurnCount(chatKey: string, surfaceIdentity?: string): number {
    const surface = surfaceIdentity?.trim();
    const row = surface
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL)`).get(chatKey, surface) as { n: number }
      : this.db.prepare(`SELECT COUNT(*) AS n FROM conversation_turns WHERE chat_key = ?`).get(chatKey) as { n: number };
    return row.n;
  }

  getLatestTurnAt(chatKey: string, surfaceIdentity?: string): string | null {
    const surface = surfaceIdentity?.trim();
    const row = surface
      ? this.db.prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? AND (surface_identity = ? OR surface_identity IS NULL) ORDER BY id DESC LIMIT 1`).get(chatKey, surface) as { created_at: string } | undefined
      : this.db.prepare(`SELECT created_at FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`).get(chatKey) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  getLatestSummaryAt(chatKey: string, surfaceIdentity?: string): string | null {
    // Historical summaries do not carry canonical surface provenance. Never
    // expose one through a surface-scoped status query.
    if (surfaceIdentity?.trim()) return null;
    const row = this.db
      .prepare(`SELECT created_at FROM conversation_summaries WHERE chat_key = ? ORDER BY id DESC LIMIT 1`)
      .get(chatKey) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }
}
