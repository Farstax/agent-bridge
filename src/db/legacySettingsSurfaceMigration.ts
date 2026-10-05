import type Database from "better-sqlite3";

const KNOWN_SURFACES = ["telegram:interactive", "discord:interactive"] as const;
const HANDOFF_PROVIDERS = ["codex", "claude", "antigravity", "grok", "cursor"] as const;

function legacySurface(role?: string): string {
  return role === "discord" ? "discord:interactive" : "telegram:interactive";
}

function isAlreadySurfaceScoped(middle: string): boolean {
  return KNOWN_SURFACES.some((surface) => middle === surface || middle.startsWith(`${surface}:`));
}

/**
 * Version 19: migrate pre-v18 `antigravity:narration:*` and `handoff_required:*`
 * settings rows onto their surface-scoped keys.
 *
 * Version 18 (#929) made every durable conversation-owned row surface-scoped,
 * but missed these two settings-table key families, so an existing narration
 * preference or pending handoff marker became invisible after upgrade. This
 * runs as its own guarded step -- rather than extending version 18's body --
 * because a database that already migrated to v18 (and has been live since)
 * will never re-run version 18's migration function; only a new version
 * reaches it.
 *
 * Provenance follows the exact same rule version 18 already uses
 * (legacySurface(role), with the outward_acp_sessions join as the one
 * deterministic override) rather than inventing a new one. Both settings
 * families are written exclusively by the Telegram/Discord interactive
 * engine -- never by the outward ACP server -- so a legacy row whose chat key
 * nonetheless matches a known outward ACP conversation id is left untouched
 * under its original key instead of being guessed into `${surface}`.
 */
export function applyLegacySettingsSurfaceMigration(db: Database.Database, role?: string): void {
  const hasTable = (name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  if (!hasTable("settings")) return;

  const surface = legacySurface(role);
  const outwardConversationIds = hasTable("outward_acp_sessions")
    ? new Set((db.prepare("SELECT conversation_id FROM outward_acp_sessions").all() as Array<{ conversation_id: string }>).map((row) => row.conversation_id))
    : new Set<string>();

  const insertIfAbsent = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  const deleteRow = db.prepare("DELETE FROM settings WHERE key = ?");

  const narrationRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'antigravity:narration:%'")
    .all() as Array<{ key: string; value: string }>;
  for (const row of narrationRows) {
    const chatKey = row.key.slice("antigravity:narration:".length);
    if (isAlreadySurfaceScoped(chatKey)) continue;
    if (outwardConversationIds.has(chatKey)) continue;
    insertIfAbsent.run(`antigravity:narration:${surface}:${chatKey}`, row.value);
    deleteRow.run(row.key);
  }

  const handoffRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'handoff_required:%'")
    .all() as Array<{ key: string; value: string }>;
  for (const row of handoffRows) {
    const rest = row.key.slice("handoff_required:".length);
    const provider = HANDOFF_PROVIDERS.find((candidate) => rest.endsWith(`:${candidate}`));
    if (!provider) continue;
    const chatKey = rest.slice(0, rest.length - provider.length - 1);
    if (isAlreadySurfaceScoped(chatKey)) continue;
    if (outwardConversationIds.has(chatKey)) continue;
    insertIfAbsent.run(`handoff_required:${surface}:${chatKey}:${provider}`, row.value);
    deleteRow.run(row.key);
  }
}
