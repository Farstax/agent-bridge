import type { BridgeDb } from "../db.js";
import type { BotKind } from "../types.js";
import { resolveRuntimeForBotName } from "./acpRuntime.js";

function acpSessionBindingKey(
  kind: BotKind | "custom-acp",
  resolveRuntime: typeof resolveRuntimeForBotName,
): string | null {
  const runtime = resolveRuntime(kind, process.env);
  if (!runtime || runtime.transport !== "acp-stdio") return null;
  return runtime.providerId === "custom-acp" ? runtime.runtimeIdentity : runtime.providerId;
}

/** Route provider session state through the store owned by the resolved runtime transport. */
export function lookupProviderSession(
  db: BridgeDb,
  chatKey: string,
  kind: BotKind | "custom-acp",
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): string | null {
  const bindingKey = acpSessionBindingKey(kind, resolveRuntime);
  if (bindingKey) {
    return db.getAcpSessionBinding(chatKey, bindingKey)?.acpSessionId ?? null;
  }
  return db.getSession(chatKey, kind as BotKind);
}

export function persistProviderSession(
  db: BridgeDb,
  chatKey: string,
  kind: BotKind | "custom-acp",
  sessionId: string | null,
  runId: string | null = null,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): void {
  const bindingKey = acpSessionBindingKey(kind, resolveRuntime);
  if (bindingKey) {
    if (sessionId) {
      db.putAcpSessionBinding({
        conversationId: chatKey,
        providerId: bindingKey,
        acpSessionId: sessionId,
        runId,
      });
    } else {
      db.clearAcpSessionBinding(chatKey, bindingKey);
      // Remove any pre-ACP compatibility pointer during reset/handoff too.
      if (kind !== "custom-acp") {
        db.setSession(chatKey, kind, null);
      }
    }
    return;
  }
  if (kind !== "custom-acp") {
    db.setSession(chatKey, kind, sessionId);
  }
}
