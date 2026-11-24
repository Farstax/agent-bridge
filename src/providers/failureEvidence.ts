/**
 * Provider-origin evidence carried on an error from the ACP runtime to the
 * recovery owners. `promptSubmitted` is false only when no `session/prompt`
 * request was ever sent across every attempt of the admitted provider call, so
 * the provider cannot have started the task. Absent evidence means unknown.
 */
export interface ProviderFailureEvidence {
  readonly promptSubmitted: boolean;
  /** Native session of the submitted attempt, observed at the protocol boundary. */
  readonly sessionId?: string;
}

const EVIDENCE_KEY = "providerFailureEvidence";

export function attachProviderFailureEvidence<T>(error: T, evidence: ProviderFailureEvidence): Error {
  const target = error instanceof Error ? error : new Error(String(error));
  (target as unknown as Record<string, unknown>)[EVIDENCE_KEY] = { ...evidence };
  return target;
}

export function readProviderFailureEvidence(error: unknown): ProviderFailureEvidence | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as Record<string, unknown>)[EVIDENCE_KEY];
  if (!value || typeof value !== "object") return null;
  const submitted = (value as { promptSubmitted?: unknown }).promptSubmitted;
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  return typeof submitted === "boolean" ? { promptSubmitted: submitted,
    ...(submitted && typeof sessionId === "string" && sessionId ? { sessionId } : {}) } : null;
}

/** Submission is monotonic: once any attempt submitted the prompt it stays submitted. */
export function mergeProviderFailureEvidence(
  ...parts: Array<ProviderFailureEvidence | null | undefined>
): ProviderFailureEvidence | null {
  const known = parts.filter((part): part is ProviderFailureEvidence => Boolean(part));
  if (known.length === 0) return null;
  return { promptSubmitted: known.some((part) => part.promptSubmitted) };
}
