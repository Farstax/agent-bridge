import type { BridgeDb } from "../db.js";
import type { BotKind } from "../types.js";
import { acpProviderIdForBotName, resolveRuntimeForBotName } from "./acpRuntime.js";

/** Route provider session state through the store owned by the resolved runtime transport. */
export function lookupProviderSession(
  db: BridgeDb,
  chatKey: string,
  kind: BotKind,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): string | null {
  const acpProviderId = acpProviderIdForBotName(kind, process.env, resolveRuntime);
  if (acpProviderId) {
    return db.getAcpSessionBinding(chatKey, acpProviderId)?.acpSessionId ?? null;
  }
  return db.getSession(chatKey, kind);
}

export function persistProviderSession(
  db: BridgeDb,
  chatKey: string,
  kind: BotKind,
  sessionId: string | null,
  runId: string | null = null,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): void {
  const acpProviderId = acpProviderIdForBotName(kind, process.env, resolveRuntime);
  if (acpProviderId) {
    if (sessionId) {
      db.putAcpSessionBinding({
        conversationId: chatKey,
        providerId: acpProviderId,
        acpSessionId: sessionId,
        runId,
      });
    } else {
      db.clearAcpSessionBinding(chatKey, acpProviderId);
      // Remove any pre-ACP compatibility pointer during reset/handoff too.
      db.setSession(chatKey, kind, null);
    }
    return;
  }
  db.setSession(chatKey, kind, sessionId);
}
