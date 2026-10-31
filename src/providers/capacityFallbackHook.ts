/**
 * PURPOSE: Single, surface-neutral implementation of the
 * onProviderFallbackRequested capacity-evidence hook that BridgeEngine calls
 * per CLI. Telegram and Discord previously duplicated this logic verbatim
 * in their entrypoints; Slack had none of it (#1114 Phase 2/3). All three
 * now call this same factory.
 * NEIGHBORS: src/engine.ts, src/index-interactive.ts,
 * src/index-discord-interactive.ts, src/index-slack-interactive.ts
 */
import { capacityRetryAfterSeconds, combineCapacityRetryOpportunities, type CapacityRetryOpportunity } from "./capacityRetryTiming.js";
import type { ProviderFallbackReason } from "./recoveryVerdict.js";

export interface CapacityFallbackAttempt extends CapacityRetryOpportunity {
  runId: string;
  chatId: number | string;
  chatType: string;
  threadId?: number | string;
  provider?: string;
}

export type ProviderFallbackRequestedContext = {
  runId: string;
  provider?: string;
  chatId: number | string;
  chatType: string;
  threadId?: number | string;
  retryAfterSeconds?: number;
  hasUnknownCapacityTiming?: true;
};

export interface CapacityFallbackHookDeps {
  fallbackRequests: Map<string, ProviderFallbackReason>;
  capacityFallbackAttempts: Map<string, CapacityFallbackAttempt>;
  /** Only ever consulted for the codex provider when context omits a retry time. */
  fetchCodexCapacityResetAt?: () => Promise<string | null>;
}

export type ProviderFallbackRequestedHook = (
  chatKey: string,
  reason: ProviderFallbackReason,
  context?: ProviderFallbackRequestedContext,
) => Promise<void>;

/**
 * Builds the onProviderFallbackRequested hook for one CLI's BridgeEngine.
 * Accumulates capacity retry evidence per chat across repeated attempts
 * (combineCapacityRetryOpportunities) so a later durable capacity wait is
 * keyed to the tightest known retry window across every provider that
 * rejected this chat's turn.
 */
export function createCapacityFallbackRequestedHook(kind: string, deps: CapacityFallbackHookDeps): ProviderFallbackRequestedHook {
  return async (chatKey, reason, context) => {
    deps.fallbackRequests.set(chatKey, reason);
    if (reason !== "capacity" || !context) return;

    const resetAt = kind === "codex" && context.retryAfterSeconds === undefined && deps.fetchCodexCapacityResetAt
      ? await deps.fetchCodexCapacityResetAt().catch(() => null)
      : null;
    const retryAfterSeconds = resetAt
      ? capacityRetryAfterSeconds({ data: { capacityResetsAt: resetAt } }) ?? undefined
      : context.retryAfterSeconds;

    const previous = deps.capacityFallbackAttempts.get(chatKey);
    const combined = combineCapacityRetryOpportunities(previous, {
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      ...(context.hasUnknownCapacityTiming || retryAfterSeconds === undefined ? { hasUnknownCapacityTiming: true } : {}),
    });
    deps.capacityFallbackAttempts.set(chatKey, {
      ...context,
      provider: kind,
      retryAfterSeconds: combined.retryAfterSeconds,
      ...(combined.hasUnknownCapacityTiming ? { hasUnknownCapacityTiming: true as const } : {}),
    });
  };
}
