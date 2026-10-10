import type { BridgeDb } from "./db.js";
import type { BridgeEngine, SurfaceNeutralTurnInput } from "./engine.js";
import type { BridgeEvent } from "./events/types.js";
import { getCachedAvailableCliKinds } from "./interactiveCliAuth.js";
import type { CliKind } from "./interactiveBot.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import { providerIdForBotName } from "./providers/registry.js";
import { readProviderFailureEvidence } from "./providers/failureEvidence.js";
import { decideProviderRecovery } from "./providers/recoveryVerdict.js";
import type { BotKind } from "./types.js";

export interface SurfaceNeutralProviderRouterOptions {
  db: BridgeDb;
  surfaceIdentity: string;
  initialProvider: BotKind;
  providerChain: readonly BotKind[];
  engineForProvider: (provider: BotKind) => Pick<BridgeEngine, "executeSurfaceNeutralTurn">;
  /**
   * Same routeability predicate interactive routing uses (see
   * canonicalProviderAvailability). Omitted only where every chain member is
   * known runnable, e.g. unit tests.
   */
  isProviderAvailable?: (provider: BotKind) => boolean;
}

/** Canonical executable/auth/runtime availability; qualification failure alone is not unavailability (#910). */
export function canonicalProviderAvailability(provider: BotKind): boolean {
  return getCachedAvailableCliKinds().has(provider as CliKind);
}

/**
 * Provider-neutral fallback for non-messaging Runs.
 * BridgeEngine retains same-provider model fallback; this only advances to the
 * next configured CLI after that provider has exhausted its own model chain.
 */
export function createSurfaceNeutralProviderRouter(
  options: SurfaceNeutralProviderRouterOptions,
): Pick<BridgeEngine, "executeSurfaceNeutralTurn"> {
  const ordered = [
    options.initialProvider,
    ...options.providerChain.filter((provider) => provider !== options.initialProvider),
  ];
  const isAvailable = options.isProviderAvailable ?? (() => true);
  const fallback = new ProviderFallbackChain(
    ordered,
    options.db,
    options.surfaceIdentity,
    (provider) => isAvailable(provider as BotKind),
  );
  const initialized = new Set<string>();

  return {
    async executeSurfaceNeutralTurn(input: SurfaceNeutralTurnInput) {
      if (!initialized.has(input.chatKey)) {
        fallback.setActiveCli(input.chatKey, options.initialProvider);
        initialized.add(input.chatKey);
      }

      for (;;) {
        const provider = fallback.getActiveCli(input.chatKey) as BotKind;
        // The chain returns its head when nothing is routeable; a non-messaging
        // Run must fail clearly instead of invoking an unusable provider.
        if (!isAvailable(provider)) throw new Error("no available provider in the configured chain");
        const engine = options.engineForProvider(provider);
        let attemptEvents: BridgeEvent[] = [];
        const providerInput: SurfaceNeutralTurnInput = {
          ...input,
          eventContext: { ...input.eventContext, bot: provider },
          // BridgeEngine emits run.started for every actual CLI process,
          // including same-provider model fallback and fresh-session retries.
          // A new process supersedes the abandoned attempt for this one
          // durable Run, so retain only bounded lifecycle events from the
          // latest real attempt. Text deltas remain streaming/non-terminal.
          collect: (event) => {
            if (event.type === "text.delta") {
              input.collect(event);
              return;
            }
            if (event.type === "run.started") {
              input.onProviderExecutionStarted?.();
              attemptEvents = [event];
              return;
            }
            attemptEvents.push(event);
          },
        };
        try {
          const result = await engine.executeSurfaceNeutralTurn(providerInput);
          const completed = [...attemptEvents].reverse().find(
            (event): event is Extract<BridgeEvent, { type: "run.completed" }> => event.type === "run.completed",
          );
          for (const event of attemptEvents) {
            if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.completed") continue;
            input.collect(event);
          }
          if (completed) {
            input.collect({ ...completed, text: result.text, sessionId: result.sessionId });
          }
          return result;
        } catch (error) {
          // Same authoritative verdict as interactive routing; this router only
          // advances along the chain it was constructed with.
          // Without the interactive handoff context a non-messaging Run must not
          // be blindly replayed: only provider rejections (capacity/auth) or a
          // failure proven to precede prompt submission may advance the chain.
          const failure = error instanceof Error ? error : new Error(String(error));
          const decision = decideProviderRecovery(providerIdForBotName(provider), failure);
          const recoverable = decision.reason === "capacity"
            || decision.reason === "auth_required"
            || (decision.reason !== null && readProviderFailureEvidence(failure)?.promptSubmitted === false);
          if (!recoverable) {
            for (const event of attemptEvents) input.collect(event);
            throw error;
          }
          const next = fallback.advance(input.chatKey);
          if (!next) {
            for (const event of attemptEvents) input.collect(event);
            throw error;
          }
          // The failed provider/model attempt was abandoned in favour of the
          // next configured CLI. Do not let its terminal event settle the
          // single durable Run owned by the eventual successful attempt.
        }
      }
    },
  };
}
