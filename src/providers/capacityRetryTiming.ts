/**
 * PURPOSE: Validate provider-owned capacity reset telemetry before it can
 * influence a durable retry. Unknown and malformed values stay unknown.
 */
const MIN_DELAY_SECONDS = 5;
const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_RESET_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const RESET_GUARD_SECONDS = 5;

export function capacityRetryAfterSeconds(error: unknown, nowMs = Date.now()): number | null {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : null;
  const reset = data && typeof data === "object" ? (data as { capacityResetsAt?: unknown }).capacityResetsAt : null;
  if (typeof reset !== "string") return null;
  const resetMs = Date.parse(reset);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs || resetMs - nowMs > MAX_RESET_WINDOW_MS) return null;
  return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.ceil((resetMs - nowMs) / 1_000) + RESET_GUARD_SECONDS));
}

export interface CapacityRetryOpportunity {
  retryAfterSeconds?: number;
  hasUnknownCapacityTiming?: true;
}

export const BOUNDED_UNKNOWN_RETRY_SECONDS = 300;

export function combineCapacityRetryOpportunities(
  previous?: CapacityRetryOpportunity,
  current?: CapacityRetryOpportunity,
): CapacityRetryOpportunity {
  if (!previous) return current ?? { hasUnknownCapacityTiming: true };
  if (!current) return previous;

  const hasUnknown = Boolean(previous.hasUnknownCapacityTiming || current.hasUnknownCapacityTiming);
  const knownOpportunities: number[] = [];
  if (previous.retryAfterSeconds !== undefined && !previous.hasUnknownCapacityTiming) {
    knownOpportunities.push(previous.retryAfterSeconds);
  }
  if (current.retryAfterSeconds !== undefined && !current.hasUnknownCapacityTiming) {
    knownOpportunities.push(current.retryAfterSeconds);
  }

  const minKnown = knownOpportunities.length > 0 ? Math.min(...knownOpportunities) : undefined;

  if (!hasUnknown) {
    return minKnown !== undefined ? { retryAfterSeconds: minKnown } : { hasUnknownCapacityTiming: true };
  }

  if (minKnown !== undefined && minKnown < BOUNDED_UNKNOWN_RETRY_SECONDS) {
    return { retryAfterSeconds: minKnown };
  }

  return {
    retryAfterSeconds: BOUNDED_UNKNOWN_RETRY_SECONDS,
    hasUnknownCapacityTiming: true,
  };
}
