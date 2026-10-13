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
