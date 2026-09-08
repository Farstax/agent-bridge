export interface AcpSessionBinding {
  readonly conversationId: string;
  readonly runId: string | null;
  readonly providerId: string;
  readonly acpSessionId: string;
}

function key(conversationId: string, providerId: string): string {
  return `${conversationId}\0${providerId}`;
}

/**
 * Explicit mapping from Agent Bridge durable conversation identity to a
 * provider-owned ACP session ID. The ACP session ID is never the Bridge
 * conversation or Run identity.
 */
export class AcpSessionMap {
  private readonly bindings = new Map<string, AcpSessionBinding>();

  bind(binding: AcpSessionBinding): void {
    if (!binding.conversationId.trim()) throw new Error("ACP session binding requires a Bridge conversation id");
    if (!binding.providerId.trim()) throw new Error("ACP session binding requires a provider id");
    if (!binding.acpSessionId.trim()) throw new Error("ACP session binding requires a provider ACP session id");
    if (binding.acpSessionId === binding.conversationId) {
      throw new Error("ACP session id must not equal the Bridge conversation id");
    }
    this.bindings.set(key(binding.conversationId, binding.providerId), { ...binding });
  }

  lookup(conversationId: string, providerId: string): AcpSessionBinding | null {
    return this.bindings.get(key(conversationId, providerId)) ?? null;
  }

  clear(conversationId: string, providerId: string): void {
    this.bindings.delete(key(conversationId, providerId));
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
