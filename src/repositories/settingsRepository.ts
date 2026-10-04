import Database from "better-sqlite3";
import {
  acpProviderDefaultSettingKey,
  setAcpProviderDefaultIntent,
} from "../acp/sessionConfig.js";
import { normalizeAgyModelFamily } from "../effort.js";
import { isAcpBackedBot } from "../providers/registry.js";
import { assertConversationIdentity, legacyConversationIdentity, type ConversationIdentity } from "../conversationIdentity.js";

type BotKind = "codex" | "antigravity" | "claude" | "grok" | "cursor";

type AcpSelection = { providerId: string; category: "model" | "thought_level" };

const pollingKey = (bot: string) => `$polling:${bot}`;

function acpSelectionForKey(key: string): AcpSelection | null {
  if (isAcpBackedBot(key)) return { providerId: key, category: "model" };
  if (key.startsWith("effort:")) {
    const providerId = key.slice("effort:".length);
    if (isAcpBackedBot(providerId)) return { providerId, category: "thought_level" };
  }
  return null;
}

export class SettingsRepository {
  constructor(private readonly db: Database.Database) {}

  private readRaw(key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private writeRaw(key: string, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value);
  }

  getSetting(key: string): string | null {
    const value = this.readRaw(key);
    const acpSelection = acpSelectionForKey(key);
    if (acpSelection) {
      const providerDefault = this.readRaw(
        acpProviderDefaultSettingKey(acpSelection.providerId, acpSelection.category),
      ) === "1";
      setAcpProviderDefaultIntent(acpSelection.providerId, acpSelection.category, providerDefault);
    }
    // Compatibility seam for model overrides saved before Antigravity model
    // family and effort were separated. Keep the stored row non-destructive,
    // but expose the family-level value to every runtime/UI/fallback caller.
    return key === "antigravity" && value !== null ? normalizeAgyModelFamily(value) : value;
  }

  setSetting(key: string, value: string | null): void {
    const acpSelection = acpSelectionForKey(key);
    if (acpSelection) {
      // "Use provider default" is Bridge policy, persisted separately from the
      // opaque ACP value namespace. A real advertised value named "default"
      // remains an ordinary provider value and is written unchanged here.
      const useProviderDefault = value === null;
      this.writeRaw(key, value);
      this.writeRaw(
        acpProviderDefaultSettingKey(acpSelection.providerId, acpSelection.category),
        useProviderDefault ? "1" : null,
      );
      setAcpProviderDefaultIntent(acpSelection.providerId, acpSelection.category, useProviderDefault);
      return;
    }
    this.writeRaw(key, value);
  }

  getChatRepo(identity: ConversationIdentity): string | null {
    assertConversationIdentity(identity);
    const row = this.db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(`chat:repo:${identity.surfaceIdentity}:${identity.chatKey}`) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setChatRepo(identity: ConversationIdentity, repo: string | null): void {
    assertConversationIdentity(identity);
    this.setSetting(`chat:repo:${identity.surfaceIdentity}:${identity.chatKey}`, repo);
  }

  incrementFailures(identity: ConversationIdentity | string, bot: BotKind): number {
    identity = legacyConversationIdentity(identity);
    assertConversationIdentity(identity);
    const col = `${bot}_consecutive_failures`;
    this.db
      .prepare(
        `INSERT INTO bridge_state (surface_identity, chat_id, ${col}) VALUES (?, ?, 1)
         ON CONFLICT (surface_identity, chat_id) DO UPDATE SET ${col} = ${col} + 1`
      )
      .run(identity.surfaceIdentity, identity.chatKey);
    const row = this.db
      .prepare(`SELECT ${col} AS n FROM bridge_state WHERE surface_identity = ? AND chat_id = ?`)
      .get(identity.surfaceIdentity, identity.chatKey) as { n: number } | undefined;
    return row?.n ?? 1;
  }

  resetFailures(identity: ConversationIdentity | string, bot: BotKind): void {
    identity = legacyConversationIdentity(identity);
    assertConversationIdentity(identity);
    const col = `${bot}_consecutive_failures`;
    this.db
      .prepare(`UPDATE bridge_state SET ${col} = 0 WHERE surface_identity = ? AND chat_id = ?`)
      .run(identity.surfaceIdentity, identity.chatKey);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    const row = this.db
      .prepare(
        `SELECT MAX(codex_consecutive_failures) AS codex,
                MAX(claude_consecutive_failures) AS claude,
                MAX(antigravity_consecutive_failures) AS antigravity,
                MAX(grok_consecutive_failures) AS grok,
                MAX(cursor_consecutive_failures) AS cursor
         FROM bridge_state`
      )
      .get() as { codex: number; claude: number; antigravity: number; grok: number; cursor: number } | undefined;
    if (!row) return [];
    const results: { bot: string; count: number }[] = [];
    if (row.codex > 0) results.push({ bot: "codex", count: row.codex });
    if (row.claude > 0) results.push({ bot: "claude", count: row.claude });
    if (row.antigravity > 0) results.push({ bot: "antigravity", count: row.antigravity });
    if (row.grok > 0) results.push({ bot: "grok", count: row.grok });
    if (row.cursor > 0) results.push({ bot: "cursor", count: row.cursor });
    return results;
  }

  getLastUpdateId(bot: BotKind): number {
    const row = this.db
      .prepare(`SELECT last_update_id FROM bridge_state WHERE surface_identity = ? AND chat_id = ?`)
      .get("$global", pollingKey(bot)) as { last_update_id: number } | undefined;
    return row?.last_update_id ?? 0;
  }

  setLastUpdateId(bot: BotKind, updateId: number): void {
    this.db
      .prepare(
        `INSERT INTO bridge_state (surface_identity, chat_id, last_update_id) VALUES ('$global', ?, ?)
         ON CONFLICT (surface_identity, chat_id) DO UPDATE SET
           last_update_id = MAX(last_update_id, excluded.last_update_id)`
      )
      .run(pollingKey(bot), updateId);
  }
}
