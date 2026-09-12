import type Database from "better-sqlite3";

export interface OutwardAcpSessionRecord {
  sessionId: string;
  conversationId: string;
  cwd: string;
  createdAt: string;
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
}

function toRecord(row: OutwardAcpSessionRow): OutwardAcpSessionRecord {
  return {
    sessionId: row.session_id,
    conversationId: row.conversation_id,
    cwd: row.cwd,
    createdAt: row.created_at,
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
      SELECT session_id, conversation_id, cwd, created_at
      FROM outward_acp_sessions
      WHERE session_id = ?
    `).get(sessionId) as OutwardAcpSessionRow | undefined;
    return row ? toRecord(row) : null;
  }
}
