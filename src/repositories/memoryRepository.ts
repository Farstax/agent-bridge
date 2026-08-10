import Database from "better-sqlite3";
import { buildMemoryFtsQuery } from "../db.js";

export class MemoryRepository {
  constructor(private readonly db: Database.Database) {}

  addMemory(mem: {
    id: string;
    type: string;
    scope?: string;
    text: string;
    source_chat_key?: string;
    source_cli?: string;
    source_turn_id?: number;
    source_repo_path?: string;
    confidence?: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO project_memories (id, type, scope, text, source_chat_key, source_cli, source_turn_id, source_repo_path, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mem.id,
      mem.type,
      mem.scope ?? "project",
      mem.text,
      mem.source_chat_key ?? null,
      mem.source_cli ?? null,
      mem.source_turn_id ?? null,
      mem.source_repo_path ?? null,
      mem.confidence ?? 1.0,
    );
  }

  searchMemories(query: string, limit = 5, chatKey?: string): Array<{ id: string; type: string; text: string; score: number; snippet: string }> {
    if (!query.trim()) return [];
    const ftsQuery = buildMemoryFtsQuery(query);
    if (!ftsQuery) return [];
    const scopeFilter = chatKey
      ? "AND (pm.scope IN ('project', 'global') OR (pm.scope = 'chat' AND pm.source_chat_key = ?))"
      : "AND pm.scope IN ('project', 'global')";
    const params = chatKey ? [ftsQuery, chatKey, limit] : [ftsQuery, limit];
    try {
      return this.db.prepare(`
        SELECT
          pm.id,
          pm.type,
          pm.text,
          rank AS score,
          snippet(project_memories_fts, 1, '', '', '...', 12) AS snippet
        FROM project_memories_fts fts
        JOIN project_memories pm ON pm.rowid = fts.rowid
        WHERE project_memories_fts MATCH ?
          AND pm.resolved_by IS NULL
          ${scopeFilter}
        ORDER BY rank
        LIMIT ?
      `).all(...params) as Array<{ id: string; type: string; text: string; score: number; snippet: string }>;
    } catch {
      return [];
    }
  }

  // Marks an existing memory row resolved/superseded without deleting it,
  // so it stops surfacing in default search results but stays available
  // for audit/history (issue #304).
  resolveMemory(id: string, resolvedBy: string): void {
    this.db.prepare(`UPDATE project_memories SET resolved_by = ? WHERE id = ?`).run(resolvedBy, id);
  }

  getMemoryCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM project_memories").get() as { n: number }).n;
  }

  findMemoryByText(text: string): { id: string } | null {
    return (this.db.prepare(
      `SELECT id FROM project_memories WHERE lower(text) = lower(?) LIMIT 1`,
    ).get(text) as { id: string } | undefined) ?? null;
  }

  // Pre-existing cross-domain read, predates Phase 4B (issue #135).
  // MemoryRepository needs the latest conversation turn id to source-tag
  // new memories; not moved here to keep this PR's scope to
  // advisor/conversation-turn extraction only. Candidate for a future
  // Phase 4C cleanup, not a regression introduced by this PR.
  getLatestConvTurnId(chatKey: string): number | null {
    // arch-lint-allow-legacy-sql: see note above.
    const row = this.db.prepare(
      `SELECT id FROM conversation_turns WHERE chat_key = ? ORDER BY id DESC LIMIT 1`,
    ).get(chatKey) as { id: number } | undefined;
    return row?.id ?? null;
  }
}
