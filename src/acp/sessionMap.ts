export interface AcpSessionBinding {
  readonly surfaceIdentity: string;
  readonly conversationId: string;
  readonly runId: string | null;
  readonly providerId: string;
  readonly acpSessionId: string;
}

function key(surfaceIdentity: string, conversationId: string, providerId: string): string {
  return `${surfaceIdentity}\0${conversationId}\0${providerId}`;
}

/**
 * Explicit mapping from Agent Bridge durable conversation identity to a
 * provider-owned ACP session ID. The ACP session ID is never the Bridge
 * conversation or Run identity.
 */
export class AcpSessionMap {
  private readonly bindings = new Map<string, AcpSessionBinding>();

  bind(binding: AcpSessionBinding | Omit<AcpSessionBinding, "surfaceIdentity">): void {
    const scoped = "surfaceIdentity" in binding ? binding : { ...binding, surfaceIdentity: "telegram:interactive" };
    if (!scoped.surfaceIdentity.trim()) throw new Error("ACP session binding requires a Bridge surface identity");
    if (!scoped.conversationId.trim()) throw new Error("ACP session binding requires a Bridge conversation id");
    if (!scoped.providerId.trim()) throw new Error("ACP session binding requires a provider id");
    if (!scoped.acpSessionId.trim()) throw new Error("ACP session binding requires a provider ACP session id");
    if (scoped.acpSessionId === scoped.conversationId) {
      throw new Error("ACP session id must not equal the Bridge conversation id");
    }
    this.bindings.set(key(scoped.surfaceIdentity, scoped.conversationId, scoped.providerId), { ...scoped });
  }

  lookup(surfaceIdentity: string, conversationId: string, providerId?: string): AcpSessionBinding | null {
    if (providerId === undefined) return this.bindings.get(key("telegram:interactive", surfaceIdentity, conversationId)) ?? null;
    return this.bindings.get(key(surfaceIdentity, conversationId, providerId)) ?? null;
  }

  clear(surfaceIdentity: string, conversationId: string, providerId?: string): void {
    if (providerId === undefined) this.bindings.delete(key("telegram:interactive", surfaceIdentity, conversationId));
    else this.bindings.delete(key(surfaceIdentity, conversationId, providerId));
  }

  serialize(): AcpSessionBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  static deserialize(bindings: readonly AcpSessionBinding[]): AcpSessionMap {
    const map = new AcpSessionMap();
    for (const binding of bindings) map.bind(binding);
    return map;
  }
}
