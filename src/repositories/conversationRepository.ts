import type Database from "better-sqlite3";

export const DEFAULT_CONTEXT_MAX_CHARS = 8_000;
export const DEFAULT_CONTEXT_RECENT_TURN_LIMIT = 200;

function recentTurnCandidateLimit(): number {
  const raw = process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  if (!raw) return DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_RECENT_TURN_LIMIT;
}

export interface ConvTurnRow {
  id: number;
  role: string;
  text: string;
  cli: string | null;
  created_at: string;
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
