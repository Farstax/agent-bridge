import { isCapacityExhaustedError } from "./cli.js";
import type { BridgeDb } from "./db.js";
import type { BridgeEngine, SurfaceNeutralTurnInput } from "./engine.js";
import type { BridgeEvent } from "./events/types.js";
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
          const capacityError = isCapacityExhaustedError(error instanceof Error ? error : new Error(String(error)));
          if (!capacityError) {
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
