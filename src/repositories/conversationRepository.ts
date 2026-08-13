import type Database from "better-sqlite3";

export const DEFAULT_CONTEXT_MAX_CHARS = 8_000;
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

function recentTurnCandidateLimit(): number {
  const raw = process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  if (!raw) return DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
}

// Same tokenization shape as db.ts's buildMemoryFtsQuery — lowercase,
// alphanumeric words longer than one character, deduped, capped — but
// without the FTS5-specific prefix-wildcard suffix, since this feeds a
// plain LIKE query rather than an fts5 MATCH expression.
function tokenizeSearchQuery(raw: string): string[] {
  return [...new Set(
    raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  )].slice(0, 8);
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

/**
 * Connection-bound SQL owner for conversation_turns/conversation_summaries.
 * None of these methods begin their own transaction — the pre-extraction
 * BridgeDb methods were all single-statement (or, for buildConvContext,
 * pure in-memory composition over two read methods), so none needed one.
 */
export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string): void {
    this.db
      .prepare(`INSERT INTO conversation_turns (chat_key, role, text, cli) VALUES (?, ?, ?, ?)`)
      .run(chatKey, role, text, cli ?? null);
  }

  getRecentConvTurns(chatKey: string, limit: number, sinceId?: number): ConvTurnRow[] {
    if (sinceId != null) {
      // Fetch the newest `limit` turns after sinceId (not the oldest), then
      // re-sort chronologically — mirrors the no-summary branch below so the
      // most recent context is never silently dropped once a chat exceeds
      // the candidate limit.
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
    const summary = this.getLatestConvSummary(chatKey);
    const sinceId = summary?.range_end_turn_id;
    // Fetch the newest N candidates (configurable via BRIDGE_CONTEXT_RECENT_TURN_LIMIT);
    // char budget below further culls them. This is a prompt-context cap only —
    // compaction (getConvTurnsForCompaction) always processes the full backlog.
    const candidates = this.getRecentConvTurns(chatKey, recentTurnCandidateLimit(), sinceId);
    if (!summary && candidates.length === 0) return "";

    // Walk newest-first, accumulate until char budget is exhausted
    let budget = maxChars - (summary ? summary.summary_md.length : 0);
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
    if (summary) {
      lines.push(summary.summary_md);
      lines.push("");
    }
    for (const t of selected) {
      lines.push(`${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
    }
    lines.push("[End context — continue naturally]");
    return lines.join("\n") + "\n\n";
  }

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

  getConvTurnsForCompaction(chatKey: string): ConvTurnRow[] {
    const summary = this.getLatestConvSummary(chatKey);
    return this.db
      .prepare(
        `SELECT id, role, text, cli, created_at FROM conversation_turns
         WHERE chat_key = ? AND id > ?
         ORDER BY id ASC`
      )
      .all(chatKey, summary?.range_end_turn_id ?? 0) as ConvTurnRow[];
  }

  /**
   * Issue #350: read-only, chat-scoped chronological search over
   * conversation_turns. Supplements — never replaces — the bounded
   * recent-turn window that buildConvContext/getRecentConvTurns already
   * construct; this is a separate retrieval path for older evidence that
   * has scrolled out of that window (or out of a compact summary's covered
   * range, since issue #349 stops those turns from ever being deleted).
   *
   * Scoping: strictly scoped to `chatKey` via the same WHERE clause every
   * other conversation_turns query in this class uses — matches can never
   * cross conversations/workstreams. Deliberately not additionally scoped
   * by `cli`/provider: buildConvContext and getRecentConvTurns already
   * blend turns from every CLI a chat has used (that is what makes
   * provider handoff continuity work), so a provider-scoped search here
   * would be a narrower, inconsistent contract than the context callers
   * already rely on. The `cli` column is still returned on every row so a
   * caller can see provenance and reason about it explicitly.
   *
   * Matching hits are selected newest-first so later corrections win when the
   * hit bound is reached. Each selected hit contributes its nearest preceding
   * and following turn in the same chat, then the deduplicated evidence is
   * returned in chronological order for unambiguous inspection.
   *
   * Bounds: an empty/whitespace-only query returns `[]` without querying
   * the database. Matching uses a plain indexed LIKE over
   * `conversation_turns(chat_key, id)` — no FTS5 virtual table — since
   * search is already scoped to one chat's turns, a volume plain LIKE
   * comfortably handles; result count is capped at MAX_SEARCH_TURN_LIMIT
   * and the complete context result is capped at MAX_SEARCH_CONTEXT_TURNS;
   * each returned turn's text is truncated to MAX_SEARCH_SNIPPET_CHARS so
   * results are always safe to inline into a prompt.
   */
  searchConvTurns(chatKey: string, query: string, limit = DEFAULT_SEARCH_TURN_LIMIT): ConvTurnRow[] {
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_SEARCH_TURN_LIMIT), MAX_SEARCH_TURN_LIMIT);
    const clauses = tokens.map(() => `text LIKE ? ESCAPE '\\'`).join(" OR ");
    const params = tokens.map((t) => `%${escapeLikeTerm(t)}%`);

    const matchingRows = this.db
      .prepare(
        `SELECT id, role, text, cli, created_at FROM conversation_turns
         WHERE chat_key = ? AND (${clauses})
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(chatKey, ...params, boundedLimit) as ConvTurnRow[];

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

    // Select newest hits first, but stop adding windows once the global
    // evidence bound is reached. The hit itself is always admitted before its
    // optional context, so the bound cannot silently replace a selected hit
    // with surrounding non-matches.
    for (const hit of matchingRows) {
      const existing = evidence.get(hit.id);
      if (existing) {
        evidence.set(hit.id, { ...existing, is_match: true });
        continue;
      }
      if (evidence.size >= MAX_SEARCH_CONTEXT_TURNS) break;
      evidence.set(hit.id, { ...hit, is_match: true });
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

  getUncompactedConvStats(chatKey: string): { turnCount: number; charCount: number } {
    const summary = this.getLatestConvSummary(chatKey);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS turnCount, COALESCE(SUM(LENGTH(text)), 0) AS charCount
         FROM conversation_turns WHERE chat_key = ? AND id > ?`
      )
      .get(chatKey, summary?.range_end_turn_id ?? 0) as { turnCount: number; charCount: number };
  }

  /**
   * Deletes turns up to and including `upToTurnId`. As of issue #349, this is
   * no longer invoked by normal compaction or startup maintenance — a
   * summary must never become the only surviving copy of the turns it
   * covers. This remains available as the primitive an explicit, separately
   * owned retention policy would call (e.g. a bounded age/size-based sweep),
   * not as something callers should reach for casually. `/reset`'s full
   * history clear uses clearConvHistory below, not this method.
   */
  pruneConvTurns(chatKey: string, upToTurnId: number): void {
    this.db
      .prepare(`DELETE FROM conversation_turns WHERE chat_key = ? AND id <= ?`)
      .run(chatKey, upToTurnId);
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
