import type Database from "better-sqlite3";
import type { AcpSessionBinding } from "../acp/sessionMap.js";
import { assertConversationIdentity, type ConversationIdentity } from "../conversationIdentity.js";

export class AcpSessionRepository {
  constructor(private readonly db: Database.Database) {}

  get(identity: ConversationIdentity, providerId: string): AcpSessionBinding | null {
    assertConversationIdentity(identity);
    const row = this.db.prepare(
      `SELECT surface_identity AS surfaceIdentity, conversation_id AS conversationId, provider_id AS providerId,
              acp_session_id AS acpSessionId, last_run_id AS runId
         FROM acp_session_bindings
        WHERE surface_identity = ? AND conversation_id = ? AND provider_id = ?`,
    ).get(identity.surfaceIdentity, identity.chatKey, providerId) as {
      surfaceIdentity: string;
      conversationId: string;
      providerId: string;
      acpSessionId: string;
      runId: string | null;
    } | undefined;
    if (!row) return null;
    return {
      surfaceIdentity: row.surfaceIdentity,
      conversationId: row.conversationId,
      providerId: row.providerId,
      acpSessionId: row.acpSessionId,
      runId: row.runId,
    };
  }

  put(binding: AcpSessionBinding): void {
    if (!binding.surfaceIdentity.trim()) throw new Error("ACP session binding requires a Bridge surface identity");
    if (!binding.conversationId.trim()) throw new Error("ACP session binding requires a Bridge conversation id");
    if (!binding.providerId.trim()) throw new Error("ACP session binding requires a provider id");
    if (!binding.acpSessionId.trim()) throw new Error("ACP session binding requires a provider ACP session id");
    if (binding.acpSessionId === binding.conversationId) {
      throw new Error("ACP session id must not equal the Bridge conversation id");
    }
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO acp_session_bindings (
         surface_identity, conversation_id, provider_id, acp_session_id, last_run_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (surface_identity, conversation_id, provider_id) DO UPDATE SET
         acp_session_id = excluded.acp_session_id,
         last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at`,
    ).run(binding.surfaceIdentity, binding.conversationId, binding.providerId, binding.acpSessionId, binding.runId, now, now);
  }

  clear(identity: ConversationIdentity, providerId: string): void {
    assertConversationIdentity(identity);
    this.db.prepare(
      `DELETE FROM acp_session_bindings WHERE surface_identity = ? AND conversation_id = ? AND provider_id = ?`,
    ).run(identity.surfaceIdentity, identity.chatKey, providerId);
  }
}
