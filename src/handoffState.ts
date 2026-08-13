/**
 * PURPOSE: Persistent per-chat/per-CLI one-time handoff state. Marks that the
 * next fresh provider execution for a given chat+CLI pair must receive
 * injected Agent Bridge context. The marker stays durable until the engine
 * persists provider-session evidence after a successful invocation.
 * NEIGHBORS: src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";

type HandoffDb = Pick<BridgeDb, "getSetting" | "setSetting">;

export function handoffRequiredSettingKey(chatKey: string, cliKind: string): string {
  return `handoff_required:${chatKey}:${cliKind}`;
}

export function markHandoffRequired(
  db: HandoffDb,
  chatKey: string,
  cliKind: string,
  reason: string,
): void {
  db.setSetting(
    handoffRequiredSettingKey(chatKey, cliKind),
    JSON.stringify({ reason, at: new Date().toISOString() }),
  );
}

export function isHandoffRequired(db: HandoffDb, chatKey: string, cliKind: string): boolean {
  return db.getSetting(handoffRequiredSettingKey(chatKey, cliKind)) != null;
}

export function clearHandoffRequired(db: HandoffDb, chatKey: string, cliKind: string): void {
  db.setSetting(handoffRequiredSettingKey(chatKey, cliKind), null);
}
