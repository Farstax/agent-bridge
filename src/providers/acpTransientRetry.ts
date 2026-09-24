import type { ProviderId } from "./types.js";
import { classifyProviderError, isClaudeOAuthRefreshContention } from "./errorClassification.js";

export const CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS = 60_000;
/**
 * Backoff for an ordinary transient blip (dropped ACP connection, in-band
 * system error, etc.) on any provider. Deliberately much shorter than
 * CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS, which waits on a real cross-process
 * credential-refresh lock -- a generic hiccup has nothing analogous to wait
 * on, so a short retry is the "maybe it was nothing" check, not a lock wait.
 */
export const TRANSIENT_RETRY_DELAY_MS = 2_000;
const RETRY_ABORT_POLL_MS = 250;

export class AcpTransientRetryCancelledError extends Error {
  constructor() {
    super("ACP execution cancelled before transient retry");
    this.name = "AcpTransientRetryCancelledError";
  }
}

export type AcpTransientRetryWait = (
  delayMs: number,
  abortRequested: () => boolean,
) => Promise<void>;

async function defaultWait(delayMs: number, abortRequested: () => boolean): Promise<void> {
  let remaining = delayMs;
  while (remaining > 0) {
    if (abortRequested()) throw new AcpTransientRetryCancelledError();
    const slice = Math.min(RETRY_ABORT_POLL_MS, remaining);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, slice);
      timer.unref();
    });
    remaining -= slice;
  }
  if (abortRequested()) throw new AcpTransientRetryCancelledError();
}

/**
 * Retry exactly one ACP attempt, on the same session, when the first attempt
 * fails with a `transient`-classified error (see errorClassification.ts) --
 * a dropped connection, an in-band system error, etc., for any provider.
 * Claude's OAuth-refresh lock contention is one such transient reason and
 * keeps its own much longer backoff (it's genuinely waiting on a
 * cross-process credential lock); every other transient reason gets a short
 * "maybe it was nothing" retry instead. Not attempted for any other
 * classification (capacity_exhausted, auth_required, model_unavailable,
 * fatal, unknown) -- those cannot be fixed by retrying the same session. The
 * decision callback fires exactly once for the failed first attempt and
 * says whether attempt two really starts.
 */
export async function runWithAcpTransientRetry<T>(
  providerId: ProviderId,
  operation: (attempt: 1 | 2) => Promise<T>,
  options: {
    abortRequested: () => boolean;
    wait?: AcpTransientRetryWait;
    onRetryDecision?: (error: Error, successorStarted: boolean) => void | Promise<void>;
  },
): Promise<T> {
  try {
    return await operation(1);
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (classifyProviderError(providerId, normalized).kind !== "transient") throw error;
    const retryDelayMs = providerId === "claude" && isClaudeOAuthRefreshContention(normalized)
      ? CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS
      : TRANSIENT_RETRY_DELAY_MS;
    if (options.abortRequested()) {
      await options.onRetryDecision?.(normalized, false);
      throw new AcpTransientRetryCancelledError();
    }
    try {
      await (options.wait ?? defaultWait)(retryDelayMs, options.abortRequested);
    } catch (waitError) {
      await options.onRetryDecision?.(normalized, false);
      throw waitError;
    }
    if (options.abortRequested()) {
      await options.onRetryDecision?.(normalized, false);
      throw new AcpTransientRetryCancelledError();
    }
    const successor = operation(2);
    await options.onRetryDecision?.(normalized, true);
    return successor;
  }
}
