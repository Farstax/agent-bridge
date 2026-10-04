import Database from "better-sqlite3";
import { assertConversationIdentity, type ConversationIdentity } from "../conversationIdentity.js";

type BotKind = "codex" | "antigravity" | "claude" | "grok" | "cursor";

const VALID_BOTS = new Set<string>(["codex", "antigravity", "claude", "grok", "cursor"]);

function assertBot(bot: string): asserts bot is BotKind {
  if (!VALID_BOTS.has(bot)) throw new Error(`Invalid bot kind: ${bot}`);
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  getSession(identity: ConversationIdentity, bot: BotKind): string | null {
    assertConversationIdentity(identity);
    assertBot(bot);
    const col = `${bot}_session_id`;
    const row = this.db
      .prepare(`SELECT ${col} AS sid FROM bridge_state WHERE surface_identity = ? AND chat_id = ?`)
      .get(identity.surfaceIdentity, identity.chatKey) as { sid: string | null } | undefined;
    return row?.sid ?? null;
  }

  setSession(identity: ConversationIdentity, bot: BotKind, sessionId: string | null): void {
    assertConversationIdentity(identity);
    assertBot(bot);
    const col = `${bot}_session_id`;
    const tsCol = `${bot}_session_created_at`;
    const ts = sessionId !== null ? new Date().toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO bridge_state (surface_identity, chat_id, ${col}, ${tsCol}) VALUES (?, ?, ?, ?)
         ON CONFLICT (surface_identity, chat_id) DO UPDATE SET ${col} = excluded.${col}, ${tsCol} = CASE
           WHEN excluded.${col} IS NULL THEN NULL
           WHEN ${col} IS NULL OR ${col} != excluded.${col} THEN excluded.${tsCol}
           ELSE ${tsCol}
         END`
      )
      .run(identity.surfaceIdentity, identity.chatKey, sessionId, ts);
  }
}
