import Database from "better-sqlite3";

type BotKind = "codex" | "antigravity" | "claude";

const VALID_BOTS = new Set<string>(["codex", "antigravity", "claude"]);

function assertBot(bot: string): asserts bot is BotKind {
  if (!VALID_BOTS.has(bot)) throw new Error(`Invalid bot kind: ${bot}`);
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  getSession(chatId: string, bot: BotKind): string | null {
    assertBot(bot);
    const col = `${bot}_session_id`;
    const row = this.db
      .prepare(`SELECT ${col} AS sid FROM bridge_state WHERE chat_id = ?`)
      .get(chatId) as { sid: string | null } | undefined;
    return row?.sid ?? null;
  }

  setSession(chatId: string, bot: BotKind, sessionId: string | null): void {
    assertBot(bot);
    const col = `${bot}_session_id`;
    const tsCol = `${bot}_session_created_at`;
    const ts = sessionId !== null ? new Date().toISOString() : null;
    this.db
      .prepare(
        `INSERT INTO bridge_state (chat_id, ${col}, ${tsCol}) VALUES (?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET ${col} = excluded.${col}, ${tsCol} = CASE
           WHEN excluded.${col} IS NULL THEN NULL
           WHEN ${col} IS NULL OR ${col} != excluded.${col} THEN excluded.${tsCol}
           ELSE ${tsCol}
         END`
      )
      .run(chatId, sessionId, ts);
  }
}
