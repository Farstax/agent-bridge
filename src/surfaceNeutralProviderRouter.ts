import { isCapacityExhaustedError } from "./cli.js";
import type { BridgeDb } from "./db.js";
import type { BridgeEngine, SurfaceNeutralTurnInput } from "./engine.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import type { BotKind } from "./types.js";

export interface SurfaceNeutralProviderRouterOptions {
  db: BridgeDb;
  initialProvider: BotKind;
  providerChain: readonly BotKind[];
  engineForProvider: (provider: BotKind) => Pick<BridgeEngine, "executeSurfaceNeutralTurn">;
}

/**
 * Provider-neutral capacity fallback for non-messaging Runs.
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
  const fallback = new ProviderFallbackChain(ordered, options.db);
  const initialized = new Set<string>();

  return {
    async executeSurfaceNeutralTurn(input: SurfaceNeutralTurnInput) {
      if (!initialized.has(input.chatKey)) {
        fallback.setActiveCli(input.chatKey, options.initialProvider);
        initialized.add(input.chatKey);
      }

      for (;;) {
        const provider = fallback.getActiveCli(input.chatKey) as BotKind;
        const engine = options.engineForProvider(provider);
        const providerInput: SurfaceNeutralTurnInput = {
          ...input,
          eventContext: { ...input.eventContext, bot: provider },
          // BridgeEngine emits run.started for every actual CLI process,
          // including same-provider model fallback and fresh-session retries.
          // Reuse that production event boundary so Run-scoped attempt state
          // cannot leak from a failed provider attempt into the successful one.
          collect: (event) => {
            if (event.type === "run.started") input.onProviderExecutionStarted?.();
            input.collect(event);
          },
        };
        try {
          return await engine.executeSurfaceNeutralTurn(providerInput);
        } catch (error) {
          if (!isCapacityExhaustedError(error instanceof Error ? error : new Error(String(error)))) throw error;
          const next = fallback.advance(input.chatKey);
          if (!next) throw error;
        }
      }
    },
  };
}
