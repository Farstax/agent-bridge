import type { BridgeDb } from "../db.js";
import type { BotKind } from "../types.js";
import type { ConversationIdentity } from "../conversationIdentity.js";
import { legacyConversationIdentity } from "../conversationIdentity.js";
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
  identity: ConversationIdentity | string,
  kind: BotKind | "custom-acp",
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): string | null {
  identity = legacyConversationIdentity(identity);
  const bindingKey = acpSessionBindingKey(kind, resolveRuntime);
  if (bindingKey) {
    return db.getAcpSessionBinding(identity, bindingKey)?.acpSessionId ?? null;
  }
  return db.getSession(identity, kind as BotKind);
}

export function persistProviderSession(
  db: BridgeDb,
  identity: ConversationIdentity | string,
  kind: BotKind | "custom-acp",
  sessionId: string | null,
  runId: string | null = null,
  resolveRuntime: typeof resolveRuntimeForBotName = resolveRuntimeForBotName,
): void {
  identity = legacyConversationIdentity(identity);
  const bindingKey = acpSessionBindingKey(kind, resolveRuntime);
  if (bindingKey) {
    if (sessionId) {
      db.putAcpSessionBinding({
        surfaceIdentity: identity.surfaceIdentity,
        conversationId: identity.chatKey,
        providerId: bindingKey,
        acpSessionId: sessionId,
        runId,
      });
    } else {
      db.clearAcpSessionBinding(identity, bindingKey);
      // Remove any pre-ACP compatibility pointer during reset/handoff too.
      if (kind !== "custom-acp") {
        db.setSession(identity, kind, null);
      }
    }
    return;
  }
  if (kind !== "custom-acp") {
    db.setSession(identity, kind, sessionId);
  }
}
