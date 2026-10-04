/** Durable owner for state that belongs to one transport conversation. */
export interface ConversationIdentity {
  readonly surfaceIdentity: string;
  readonly chatKey: string;
}

export function assertConversationIdentity(identity: ConversationIdentity): void {
  if (!identity.surfaceIdentity.trim()) throw new Error("conversation surfaceIdentity is required");
  if (!identity.chatKey.trim()) throw new Error("conversation chatKey is required");
}

/** Compatibility boundary for historic callers that predate surface identity. */
export function legacyConversationIdentity(identity: ConversationIdentity | string): ConversationIdentity {
  return typeof identity === "string" ? { surfaceIdentity: "telegram:interactive", chatKey: identity } : identity;
}
