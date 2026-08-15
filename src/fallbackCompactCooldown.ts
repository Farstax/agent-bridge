/**
 * PURPOSE: Rate-limits the "compact before switching CLI on capacity fallback"
 * step so a cascading capacity exhaustion across the whole fallback chain
 * (e.g. codex -> claude -> antigravity in quick succession) doesn't
 * trigger a full compaction CLI round-trip before every single hop.
 * NEIGHBORS: src/interactiveBot.ts, src/compactConversation.ts
 */

import type { BridgeDb } from "./db.js";

type CooldownDb = Pick<BridgeDb, "getSetting" | "setSetting">;

export const DEFAULT_FALLBACK_COMPACT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function cooldownMs(): number {
  const raw = process.env.BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS;
  if (!raw) return DEFAULT_FALLBACK_COMPACT_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FALLBACK_COMPACT_COOLDOWN_MS;
}

function cooldownSettingKey(chatKey: string): string {
  return `fallback_compact_last_success_at:${chatKey}`;
}

export function shouldCompactBeforeFallback(db: CooldownDb, chatKey: string): boolean {
  const raw = db.getSetting(cooldownSettingKey(chatKey));
  if (!raw) return true;
  const lastAt = Date.parse(raw);
  if (!Number.isFinite(lastAt)) return true;
  return Date.now() - lastAt >= cooldownMs();
}

export function recordFallbackCompactSuccess(db: CooldownDb, chatKey: string): void {
  db.setSetting(cooldownSettingKey(chatKey), new Date().toISOString());
}
