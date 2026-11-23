import type { BridgeDb } from "./db.js";
import type { BridgeEngine, SurfaceNeutralTurnInput } from "./engine.js";
import type { BridgeEvent } from "./events/types.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import { RunRepository } from "./repositories/runRepository.js";
import { readRunOutcome, resetAbandonedRunDisposition } from "./runOutcome.js";
import { providerIdForBotName } from "./providers/registry.js";
import { decideProviderRecovery } from "./providers/recoveryVerdict.js";
import { markHandoffRequired } from "./handoffState.js";
import { toUserMessage } from "./cli.js";
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

export interface SurfaceNeutralProviderRouter extends Pick<BridgeEngine, "executeSurfaceNeutralTurn"> {
  /** Provider the next turn of this conversation starts with, after any fallback. */
  activeProvider(chatKey: string): BotKind | null;
}

/**
 * Provider-neutral fallback for non-messaging Runs.
 * BridgeEngine retains same-provider model fallback; this only advances to the
 * next configured CLI after that provider has exhausted its own model chain.
 */
export function createSurfaceNeutralProviderRouter(
  options: SurfaceNeutralProviderRouterOptions,
): SurfaceNeutralProviderRouter {
  const ordered = [
    options.initialProvider,
    ...options.providerChain.filter((provider) => provider !== options.initialProvider),
  ];
  const probe = options.isProviderAvailable ?? (() => true);
  const fallback = new ProviderFallbackChain(
    ordered,
    options.db,
    options.surfaceIdentity,
    (provider) => probe(provider as BotKind),
  );
  const initialized = new Set<string>();

  return {
    activeProvider(chatKey: string): BotKind | null {
      // Read-only peek: a status/list poll must never mutate shared per-chat
      // routing state while a real attempt may be concurrently executing or
      // about to advance (#1114 P0). This also covers the uninitialised-chat
      // case correctly: chatActiveIdx defaults to the configured head either
      // way, so an unavailable head is never advertised as nextProvider
      // before the first turn.
      return fallback.peekActiveCli(chatKey) as BotKind | null;
    },
    async executeSurfaceNeutralTurn(input: SurfaceNeutralTurnInput) {
      if (!initialized.has(input.chatKey)) {
        fallback.setActiveCli(input.chatKey, options.initialProvider);
        initialized.add(input.chatKey);
      }

      // A recovery stays inside the admitted Run and the existing finite fallback chain.
      // Each provider can receive at most one fresh, inspection-first recovery attempt.
      let attemptMode: "initial" | "recovery" | "fallback" = "initial";
      const failures: string[] = [];
      for (;;) {
        const provider = fallback.getActiveCli(input.chatKey) as BotKind;
        // The chain returns its head when nothing is routeable; a non-messaging
        // Run must fail clearly instead of invoking an unusable provider.
        if (!probe(provider)) {
          console.error(`[surface-neutral-router] no available provider in chain ${ordered.join(",")} surface=${options.surfaceIdentity ?? "unknown"}`);
          throw new Error("no available provider in the configured chain");
        }
        // An outcome/continuation helper runs *inside* the native provider
        // attempt, before buffered run.started events are published. Its
        // provider fence must already match this attempt, including after a
        // cross-provider fallback. Use the existing Run repository and lane
        // fence rather than adding another ACP lifecycle/settlement owner.
        const activeRun = options.db.getRun(input.runId);
        if (activeRun?.status === "running" && activeRun.bot !== provider) {
          options.db.runWithLockFence(input.laneHandle, () => {
            if (!new RunRepository(options.db.raw).updateRunningRunBot(input.runId, provider)) {
              throw new Error("outward Run provider attribution lost its active Run");
            }
          });
        }
        const engine = options.engineForProvider(provider);
        let attemptEvents: BridgeEvent[] = [];
        const providerInput: SurfaceNeutralTurnInput = {
          ...input,
          prompt: failures.length === 0 ? input.prompt : [
            "[Agent Bridge provider recovery]",
            "Original objective follows below. Inspect previous tool actions, repository state, artifacts and durable outcomes before any side effect.",
            "Preserve verified progress and perform only unfinished work. Do not retry an action whose result is uncertain without inspecting it first.",
            ...failures.slice(-3).map((failure) => "Previous provider error: " + failure),
            "",
            input.prompt,
          ].join("\n"),
          // The original continuation session is mandatory only for its admitted
          // first attempt. A successor provider must never inherit that requirement.
          requireBoundProviderSession: input.requireBoundProviderSession === true && attemptMode === "initial",
          freshProviderSession: attemptMode !== "initial",
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
          // A completed/blocked outcome is not an abandoned attempt. Keep a
          // scheduled continuation when only its final presentation was lost;
          // for an actual provider failure, preserve the existing stale-wake
          // cleanup and inspection-first successor behaviour.
          const disposition = readRunOutcome(options.db, input.runId);
          const settled = disposition?.status === "complete" || disposition?.status === "blocked"
            || (disposition?.status === "continue" && failure.name === "MissingAcpAnswerError");
          const recoverable = decision.reason !== null && !settled && input.mayContinueRecovery?.() !== false;
          if (!recoverable) {
            input.onProviderRecoveryDecision?.(null, false);
            for (const event of attemptEvents) input.collect(event);
            throw error;
          }
          // The ACP runtime supplies provenance; ordinary local errors do not
          // acquire recovery eligibility. Do not replay a failed task verbatim:
          // a fresh native session receives inspection-first context instead.
          const originalError = failure.name === "RunOutcomeReconciliationError" && failure.cause instanceof Error
            ? failure.cause : failure;
          failures.push(`${provider}: ${toUserMessage(originalError).slice(0, 1_000)}`);
          if (attemptMode !== "recovery" &&
              decision.reason !== "auth_required" && decision.reason !== "capacity" &&
              decision.reason !== "provider_unavailable") {
            if (options.db.getRun(input.runId)?.status === "running") {
              options.db.runWithLockFence(input.laneHandle, () => {
                resetAbandonedRunDisposition(options.db, input.runId);
              });
            }
            markHandoffRequired(options.db, options.surfaceIdentity, input.chatKey, provider, `fallback_from_${provider}`);
            for (const event of attemptEvents) {
              if (event.type === "run.diagnostic") input.collect(event);
            }
            attemptMode = "recovery";
            continue;
          }
          // Anchor to the provider that actually attempted and failed, not to
          // whatever chatActiveIdx currently holds — a concurrent status peek
          // must never be able to shift this (#1114 P0).
          const next = fallback.advance(input.chatKey, provider);
          input.onProviderRecoveryDecision?.(decision.reason, next === null, next && next !== provider
            ? { fromProvider: provider, toProvider: next as BotKind } : undefined);
          if (!next) {
            for (const event of attemptEvents) input.collect(event);
            throw error;
          }
          // The failed provider's disposition and pending ordinary wake
          // cannot be carried into a different provider's attempt. Reuse the
          // exact same fenced Core owner as messaging's provider retries.
          if (options.db.getRun(input.runId)?.status === "running") {
            options.db.runWithLockFence(input.laneHandle, () => {
              resetAbandonedRunDisposition(options.db, input.runId);
            });
          }
          // This route has no chat-specific presentation layer, but uses the
          // same durable inspection-first handoff context as interactive
          // turns. The successor is instructed to reconcile prior work.
          markHandoffRequired(options.db, options.surfaceIdentity, input.chatKey, next, `fallback_from_${provider}`);
          attemptMode = "fallback";
          // The failed provider/model attempt was abandoned in favour of the
          // next configured CLI. Preserve its non-terminal diagnostics for
          // audit (especially prompt-submission evidence) without letting its
          // terminal event settle the single durable Run owned by the eventual
          // successful attempt.
          for (const event of attemptEvents) {
            if (event.type === "run.diagnostic") input.collect(event);
          }
        }
      }
    },
  };
}
