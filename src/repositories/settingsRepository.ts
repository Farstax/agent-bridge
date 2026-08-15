import Database from "better-sqlite3";

type BotKind = "codex" | "antigravity" | "claude";

const pollingKey = (bot: string) => `$polling:${bot}`;

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getSetting(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  getChatRepo(chatId: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(`chat:repo:${chatId}`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setChatRepo(chatId: string, repo: string | null): void {
    this.setSetting(`chat:repo:${chatId}`, repo);
  }

  incrementFailures(chatId: string, bot: BotKind): number {
    const col = `${bot}_consecutive_failures`;
    this.db
      .prepare(
        `INSERT INTO bridge_state (chat_id, ${col}) VALUES (?, 1)
         ON CONFLICT (chat_id) DO UPDATE SET ${col} = ${col} + 1`
      )
      .run(chatId);
    const row = this.db
      .prepare(`SELECT ${col} AS n FROM bridge_state WHERE chat_id = ?`)
      .get(chatId) as { n: number } | undefined;
    return row?.n ?? 1;
  }

  resetFailures(chatId: string, bot: BotKind): void {
    const col = `${bot}_consecutive_failures`;
    this.db
      .prepare(`UPDATE bridge_state SET ${col} = 0 WHERE chat_id = ?`)
      .run(chatId);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    const row = this.db
      .prepare(
        `SELECT MAX(codex_consecutive_failures) AS codex,
                MAX(claude_consecutive_failures) AS claude,
                MAX(antigravity_consecutive_failures) AS antigravity
         FROM bridge_state`
      )
      .get() as { codex: number; claude: number; antigravity: number } | undefined;
    if (!row) return [];
    const results: { bot: string; count: number }[] = [];
    if (row.codex > 0) results.push({ bot: "codex", count: row.codex });
    if (row.claude > 0) results.push({ bot: "claude", count: row.claude });
    if (row.antigravity > 0) results.push({ bot: "antigravity", count: row.antigravity });
    return results;
  }

  getLastUpdateId(bot: BotKind): number {
    const row = this.db
      .prepare(`SELECT last_update_id FROM bridge_state WHERE chat_id = ?`)
      .get(pollingKey(bot)) as { last_update_id: number } | undefined;
    return row?.last_update_id ?? 0;
  }

  setLastUpdateId(bot: BotKind, updateId: number): void {
    this.db
      .prepare(
        `INSERT INTO bridge_state (chat_id, last_update_id) VALUES (?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET
           last_update_id = MAX(last_update_id, excluded.last_update_id)`
      )
      .run(pollingKey(bot), updateId);
  }
}
