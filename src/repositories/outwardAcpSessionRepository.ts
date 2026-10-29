import type Database from "better-sqlite3";

export interface OutwardAcpSessionRecord {
  sessionId: string;
  conversationId: string;
  cwd: string;
  createdAt: string;
  /** Workstream metadata (#1101); null until the owner names it. */
  title?: string | null;
  archivedAt?: string | null;
}

export interface NewOutwardAcpSession {
  sessionId: string;
  conversationId: string;
  cwd: string;
}

interface OutwardAcpSessionRow {
  session_id: string;
  conversation_id: string;
  cwd: string;
  created_at: string;
  title: string | null;
  archived_at: string | null;
}

const COLUMNS = "session_id, conversation_id, cwd, created_at, title, archived_at";

function toRecord(row: OutwardAcpSessionRow): OutwardAcpSessionRecord {
  return {
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    cwd: row.cwd,
    createdAt: row.created_at,
    title: row.title,
    archivedAt: row.archived_at,
  };
}

export class OutwardAcpSessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(session: NewOutwardAcpSession): OutwardAcpSessionRecord {
    this.db.prepare(`
      INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd)
      VALUES (?, ?, ?)
    `).run(session.sessionId, session.conversationId, session.cwd);

    const created = this.get(session.sessionId);
    if (!created) throw new Error("outward ACP session persistence failed");
    return created;
  }

  get(sessionId: string): OutwardAcpSessionRecord | null {
    const row = this.db.prepare(`
      SELECT ${COLUMNS}
      FROM outward_acp_sessions
      WHERE session_id = ?
    `).get(sessionId) as OutwardAcpSessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Workstreams of one workspace directory, newest first. */
  list(cwd: string, options: { includeArchived?: boolean } = {}): OutwardAcpSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT ${COLUMNS}
      FROM outward_acp_sessions
      WHERE cwd = ? AND (? = 1 OR archived_at IS NULL)
      ORDER BY created_at DESC, rowid DESC
    `).all(cwd, options.includeArchived ? 1 : 0) as OutwardAcpSessionRow[];
    return rows.map(toRecord);
  }

  update(sessionId: string, change: { title?: string; archived?: boolean }): OutwardAcpSessionRecord | null {
    this.db.transaction(() => {
      if (change.title !== undefined) {
        this.db.prepare("UPDATE outward_acp_sessions SET title = ? WHERE session_id = ?").run(change.title, sessionId);
      }
      if (change.archived !== undefined) {
        this.db.prepare(`
          UPDATE outward_acp_sessions
          SET archived_at = CASE WHEN ? = 1 THEN COALESCE(archived_at, datetime('now')) ELSE NULL END
          WHERE session_id = ?
        `).run(change.archived ? 1 : 0, sessionId);
      }
    })();
    return this.get(sessionId);
  }
}
