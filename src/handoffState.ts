/**
 * PURPOSE: Persistent per-chat/per-CLI one-time handoff state. Marks that the
 * next fresh provider execution for a given chat+CLI pair must receive
 * injected Agent Bridge context. The marker stays durable until the engine
 * persists provider-session evidence after a successful invocation.
 * NEIGHBORS: src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";
import type { BotKind } from "./types.js";
import { notePendingRunFallback } from "./runTelemetry.js";

type HandoffDb = Pick<BridgeDb, "getSetting" | "setSetting">;

export function handoffRequiredSettingKey(surfaceIdentity: string, chatKey: string, cliKind: string): string {
  return `handoff_required:${surfaceIdentity}:${chatKey}:${cliKind}`;
}

export function markHandoffRequired(db: HandoffDb, surfaceIdentity: string, chatKey: string, cliKind: string, reason: string): void {
  db.setSetting(handoffRequiredSettingKey(surfaceIdentity, chatKey, cliKind), JSON.stringify({ reason, at: new Date().toISOString() }));
  const match = reason.match(/^fallback_from_(codex|claude|antigravity|grok|cursor)$/);
  if (match && (cliKind === "codex" || cliKind === "claude" || cliKind === "antigravity" || cliKind === "grok" || cliKind === "cursor")) {
    notePendingRunFallback(chatKey, {
      fromProvider: match[1] as BotKind,
      toProvider: cliKind,
      fromModel: null,
      toModel: null,
      attempt: 1,
    });
  } else if (reason === "manual_switch") {
    notePendingRunFallback(chatKey, null);
  }
}

export function getHandoffReason(db: HandoffDb, surfaceIdentity: string, chatKey: string, cliKind: string): string | null {
  const raw = db.getSetting(handoffRequiredSettingKey(surfaceIdentity, chatKey, cliKind));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

export function isProviderFallbackHandoffRequired(db: HandoffDb, surfaceIdentity: string, chatKey: string, cliKind: string): boolean {
  return /^fallback_from_(codex|claude|antigravity|grok|cursor)$/.test(getHandoffReason(db, surfaceIdentity, chatKey, cliKind) ?? "");
}

export function isHandoffRequired(db: HandoffDb, surfaceIdentity: string, chatKey: string, cliKind: string): boolean {
  return db.getSetting(handoffRequiredSettingKey(surfaceIdentity, chatKey, cliKind)) != null;
}

export function clearHandoffRequired(db: HandoffDb, surfaceIdentity: string, chatKey: string, cliKind: string): void {
  db.setSetting(handoffRequiredSettingKey(surfaceIdentity, chatKey, cliKind), null);
}
