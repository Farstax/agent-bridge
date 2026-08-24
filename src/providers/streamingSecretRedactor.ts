const REDACTION = "[REDACTED_PROVIDER_CREDENTIAL]";

export interface StreamingSecretRedactor {
  push(chunk: string): string;
  flush(): string;
}

/**
 * Redacts exact secrets even when a child process splits them across arbitrary
 * stdout/stderr chunk boundaries. Potential secret prefixes stay buffered until
 * they can be proven ordinary text or replaced as a complete credential.
 */
export function createStreamingSecretRedactor(
  secrets: readonly string[],
  replacement: string = REDACTION,
): StreamingSecretRedactor {
  const candidates = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  let pending = "";

  const drain = (final: boolean): string => {
    if (candidates.length === 0) {
      const output = pending;
      pending = "";
      return output;
    }

    let output = "";
    while (pending.length > 0) {
      const exact = candidates.find((secret) => pending.startsWith(secret));
      if (exact) {
        output += replacement;
        pending = pending.slice(exact.length);
        continue;
      }

      if (!final && candidates.some((secret) => secret.startsWith(pending))) break;
      output += pending[0];
      pending = pending.slice(1);
    }
    return output;
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      return drain(false);
    },
    flush(): string {
      return drain(true);
    },
  };
}
