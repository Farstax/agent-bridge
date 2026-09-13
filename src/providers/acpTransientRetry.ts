import type { ProviderId } from "./types.js";
import { isClaudeOAuthRefreshContention } from "./errorClassification.js";

export const CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS = 60_000;
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
 * Retry exactly one Claude ACP attempt when Claude itself reports the shared
 * OAuth-refresh lock race. The delay follows Claude's own "retry in a minute"
 * guidance, while polling Bridge cancellation so /stop remains authoritative.
 * Other transient/network/auth failures are never retried here.
 */
export async function runWithAcpTransientRetry<T>(
  providerId: ProviderId,
  operation: () => Promise<T>,
  options: {
    abortRequested: () => boolean;
    wait?: AcpTransientRetryWait;
  },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (providerId !== "claude" || !isClaudeOAuthRefreshContention(normalized)) throw error;
    if (options.abortRequested()) throw new AcpTransientRetryCancelledError();
    await (options.wait ?? defaultWait)(CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS, options.abortRequested);
    if (options.abortRequested()) throw new AcpTransientRetryCancelledError();
    return operation();
  }
}
