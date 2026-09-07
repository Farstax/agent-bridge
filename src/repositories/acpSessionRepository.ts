import type Database from "better-sqlite3";
import type { AcpSessionBinding } from "../acp/sessionMap.js";

export class AcpSessionRepository {
  constructor(private readonly db: Database.Database) {}

  get(conversationId: string, providerId: string): AcpSessionBinding | null {
    const row = this.db.prepare(
      `SELECT conversation_id AS conversationId, provider_id AS providerId,
              acp_session_id AS acpSessionId, last_run_id AS runId
         FROM acp_session_bindings
        WHERE conversation_id = ? AND provider_id = ?`,
    ).get(conversationId, providerId) as {
      conversationId: string;
      providerId: string;
      acpSessionId: string;
      runId: string | null;
    } | undefined;
    if (!row) return null;
    return {
      conversationId: row.conversationId,
      providerId: row.providerId,
      acpSessionId: row.acpSessionId,
      runId: row.runId,
    };
  }

  put(binding: AcpSessionBinding): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO acp_session_bindings (
         conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, provider_id) DO UPDATE SET
         acp_session_id = excluded.acp_session_id,
         last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at`,
    ).run(binding.conversationId, binding.providerId, binding.acpSessionId, binding.runId, now, now);
  }

  clear(conversationId: string, providerId: string): void {
    this.db.prepare(
      `DELETE FROM acp_session_bindings WHERE conversation_id = ? AND provider_id = ?`,
    ).run(conversationId, providerId);
  }
}
