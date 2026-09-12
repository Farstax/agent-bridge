import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { abortCliProcessAndWait } from "../cli.js";
import { loadBotsConfig, resolveExecutionMode } from "../config.js";
import type { BridgeDb } from "../db.js";
import { BridgeEngine, type SurfaceNeutralTurnInput } from "../engine.js";
import { EventStore } from "../events/store.js";
import { type as eventType, type BridgeEvent, type RunCompletedEvent } from "../events/types.js";
import { executionLaneCoordinator } from "../executionLaneCoordinator.js";
import { SAFE_SURFACE_CAPABILITIES, type MessagingPlatform } from "../platform.js";
import { interactiveChainKinds, parseCliChain } from "../providers/selection.js";
import { lookupProviderSession, persistProviderSession } from "../providers/sessionRuntime.js";
import type { OutwardAcpSessionRecord } from "../repositories/outwardAcpSessionRepository.js";
import { createSurfaceNeutralProviderRouter } from "../surfaceNeutralProviderRouter.js";
import type { BotKind, BridgeConfig, CliResult } from "../types.js";

export const OUTWARD_ACP_SURFACE = "acp:outward";
const OUTWARD_ACP_EXECUTION_ERROR = -32001;
const OUTWARD_ACP_BUSY_ERROR = -32002;
const CANCELLATION_SWEEP_MS = 10;

type OutwardUpdate = acp.SessionNotification["update"];
type RunCancelledEvent = Extract<BridgeEvent, { type: "run.cancelled" }>;

type ActiveOutwardExecution = {
  readonly session: OutwardAcpSessionRecord;
  cancelRequested: boolean;
  cancelPromise: Promise<void> | null;
  settled: boolean;
  readonly done: Promise<void>;
  readonly finishDone: () => void;
};

export interface OutwardAcpPromptExecutionInput {
  session: OutwardAcpSessionRecord;
  prompt: string;
  signal: AbortSignal;
  onUpdate: (update: OutwardUpdate) => void | Promise<void>;
}

export interface OutwardAcpPromptExecutor {
  execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse>;
  cancel(session: OutwardAcpSessionRecord): Promise<void>;
}

export type OutwardAcpExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export interface BridgeOutwardAcpPromptExecutorOptions {
  db: BridgeDb;
  /** Ordered fallback chain; [0] is the initial/head provider for a fresh session. */
  providerChain: readonly BotKind[];
  createEngine: (session: OutwardAcpSessionRecord, attemptProvider: BotKind) => OutwardAcpExecutionEngine;
  runId?: () => string;
}

type RetainedSessionUpdate = {
  kind?: unknown;
  channel?: unknown;
  acpSessionId?: unknown;
  notification?: {
    sessionId?: unknown;
    update?: unknown;
  };
};

function executionLane(conversationId: string): string {
  return JSON.stringify([OUTWARD_ACP_SURFACE, conversationId]);
}

function isBridgeAuthoritativeTextUpdate(update: OutwardUpdate): boolean {
  return update.sessionUpdate === "agent_message_chunk"
    || update.sessionUpdate === "agent_thought_chunk"
    || update.sessionUpdate === "user_message_chunk";
}

/**
 * Forward only live structured updates from the parent provider session.
 * Bridge owns human-facing answer authority: provider message/thought chunks
 * may contain replay, commentary, provisional text, or cancelled partials, so
 * the outward client receives only Bridge's final selected answer below.
 */
function liveRootProviderUpdate(event: BridgeEvent): OutwardUpdate | null {
  if (event.type !== "acp.event" || !event.event || typeof event.event !== "object") return null;
  const retained = event.event as RetainedSessionUpdate;
  if (retained.kind !== "session_update" || retained.channel !== "live") return null;
  if (typeof retained.acpSessionId !== "string" || !retained.notification) return null;
  if (retained.notification.sessionId !== retained.acpSessionId) return null;
  if (!retained.notification.update || typeof retained.notification.update !== "object") return null;
  const update = retained.notification.update as OutwardUpdate;
  return isBridgeAuthoritativeTextUpdate(update) ? null : update;
}

function normalizeStopReason(value: string | undefined): acp.StopReason {
  switch (value) {
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
    case "cancelled":
      return value;
    default:
      return "end_turn";
  }
}

function failedEvent(runId: string, provider: BotKind, session: OutwardAcpSessionRecord): BridgeEvent {
  return eventType.runFailed({
    runId,
    bot: provider,
    chatId: session.sessionId,
    chatKey: session.conversationId,
    error: "outward ACP prompt execution failed",
    category: "unknown",
  });
}

function cancelledEvent(
  runId: string,
  provider: BotKind,
  session: OutwardAcpSessionRecord,
  reason: "user" | "provider",
): RunCancelledEvent {
  return eventType.runCancelled({
    runId,
    bot: provider,
    chatId: session.sessionId,
    chatKey: session.conversationId,
    reason,
  });
}

function sweepDelay(done: Promise<void>): Promise<void> {
  return Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, CANCELLATION_SWEEP_MS)),
  ]);
}

export class BridgeOutwardAcpPromptExecutor implements OutwardAcpPromptExecutor {
  private readonly active = new Map<string, ActiveOutwardExecution>();
  // One router per conversation, reused across turns so that a fallback
  // chosen on an earlier turn stays the active provider on later turns
  // (matches Telegram's per-chat ProviderFallbackChain lifetime) rather than
  // silently retrying an already-exhausted head provider every turn.
  private readonly routers = new Map<string, OutwardAcpExecutionEngine>();

  constructor(private readonly options: BridgeOutwardAcpPromptExecutorOptions) {}

  private routerFor(session: OutwardAcpSessionRecord): OutwardAcpExecutionEngine {
    const existing = this.routers.get(session.conversationId);
    if (existing) return existing;
    const { db, providerChain, createEngine } = this.options;
    const router = createSurfaceNeutralProviderRouter({
      db,
      initialProvider: providerChain[0],
      providerChain,
      engineForProvider: (attemptProvider) => createEngine(session, attemptProvider),
    });
    this.routers.set(session.conversationId, router);
    return router;
  }

  async cancel(session: OutwardAcpSessionRecord): Promise<void> {
    const record = this.active.get(session.conversationId);
    if (!record) return;
    record.cancelRequested = true;
    if (record.cancelPromise) return record.cancelPromise;

    const lane = executionLane(session.conversationId);
    const coordinator = executionLaneCoordinator(this.options.db, OUTWARD_ACP_SURFACE);
    const operation = (async () => {
      coordinator.markResetting(lane);
      coordinator.markAborted(lane);
      try {
        // Cancellation can arrive before BridgeEngine has registered its CLI
        // lifecycle or child. Keep asserting the abort until the owning outer
        // Run settles so neither a later lifecycle nor a later child can miss it.
        while (!record.settled) {
          await abortCliProcessAndWait(lane);
          if (record.settled) break;
          await sweepDelay(record.done);
        }
      } finally {
        coordinator.clearAborted(lane);
        coordinator.clearResetting(lane);
      }
    })();
    record.cancelPromise = operation;
    try {
      await operation;
    } finally {
      if (record.cancelPromise === operation) record.cancelPromise = null;
    }
  }

  /** Cancel all active requests and wait until their outer Run persistence settles. */
  async shutdown(): Promise<void> {
    const records = [...this.active.values()];
    await Promise.all(records.map(async (record) => {
      await this.cancel(record.session);
      await record.done;
    }));
  }

  async execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse> {
    const { db, providerChain } = this.options;
    const provider = providerChain[0];
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, input.session.conversationId);
    if (!lane) {
      throw new acp.RequestError(
        OUTWARD_ACP_BUSY_ERROR,
        "outward ACP session is busy",
        { sessionId: input.session.sessionId },
      );
    }

    const runId = this.options.runId?.() ?? randomUUID();
    let eventStore: EventStore | null = null;
    let active: ActiveOutwardExecution | null = null;
    let signalAbort: (() => void) | null = null;
    try {
      db.insertRun(runId, input.session.conversationId, provider);
      eventStore = new EventStore(db, runId);

      let finishDone!: () => void;
      const done = new Promise<void>((resolve) => { finishDone = resolve; });
      active = {
        session: input.session,
        cancelRequested: input.signal.aborted,
        cancelPromise: null,
        settled: false,
        done,
        finishDone,
      };
      this.active.set(input.session.conversationId, active);
      signalAbort = () => {
        void this.cancel(input.session).catch(() => {
          console.warn("[acp:outward] cancellation cleanup failed");
        });
      };
      if (!input.signal.aborted) input.signal.addEventListener("abort", signalAbort, { once: true });

      if (active.cancelRequested) {
        eventStore.collect(cancelledEvent(runId, provider, input.session, "user"));
        eventStore.finalize();
        return { stopReason: "cancelled" };
      }

      let completed: RunCompletedEvent | null = null;
      let providerCancelled: RunCancelledEvent | null = null;
      let updateChain = Promise.resolve();
      const enqueueUpdate = (update: OutwardUpdate): void => {
        updateChain = updateChain.then(() => input.onUpdate(update));
      };
      const collect = (event: BridgeEvent): void => {
        if (event.type === "run.completed") completed = event;
        else if (event.type === "run.cancelled") providerCancelled = event;
        else eventStore!.collect(event);
        const update = liveRootProviderUpdate(event);
        if (update) enqueueUpdate(update);
      };

      const eventContext: NonNullable<SurfaceNeutralTurnInput["eventContext"]> = {
        runId,
        bot: provider,
        chatId: input.session.sessionId,
        chatKey: input.session.conversationId,
        threadId: undefined,
        serviceId: lane.serviceId,
        acquisitionId: lane.acquisitionId,
      };

      const result: CliResult = await this.routerFor(input.session).executeSurfaceNeutralTurn({
        prompt: input.prompt,
        // Resolved per-attempt by createEngine's wrapper for whichever
        // provider the fallback router is actually trying this attempt --
        // fallback providers have their own distinct provider-session binding.
        sessionId: null,
        chatId: input.session.sessionId,
        chatKey: input.session.conversationId,
        laneHandle: lane,
        runId,
        eventContext,
        collect,
      });

      const cancelled = active.cancelRequested || result.stopReason === "cancelled";
      // The router may have fallen back to a different provider mid-turn;
      // attribute persistence to whichever provider actually produced the
      // terminal event, not the (possibly abandoned) head provider.
      const terminalBot = (event: { bot: BotKind } | null): BotKind | undefined => event?.bot;
      const actualProvider: BotKind = terminalBot(completed) ?? terminalBot(providerCancelled) ?? provider;
      db.runWithLockFence(lane, () => {
        persistProviderSession(db, input.session.conversationId, actualProvider, result.sessionId, runId);
        // Durable transcript for `session/load` replay only — mirrors the
        // generic addConvTurn seam Telegram/Discord already use, so a
        // cancelled/partial turn (with no authoritative final text) never
        // enters replay history, matching Bridge's final-answer authority.
        if (!cancelled && result.text) {
          db.addConvTurn(input.session.conversationId, "user", input.prompt, actualProvider, {
            surfaceIdentity: OUTWARD_ACP_SURFACE,
          });
          db.addConvTurn(input.session.conversationId, "assistant", result.text, actualProvider, {
            surfaceIdentity: OUTWARD_ACP_SURFACE,
          });
        }
      });

      if (!cancelled && result.text) {
        enqueueUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        });
      }
      await updateChain;

      if (cancelled) {
        if (db.getRun(runId)?.status === "running") {
          eventStore.collect(active.cancelRequested
            ? cancelledEvent(runId, actualProvider, input.session, "user")
            : providerCancelled ?? cancelledEvent(runId, actualProvider, input.session, "provider"));
        }
      } else if (completed) {
        eventStore.queueCompleted(completed);
      } else {
        eventStore.queueCompleted(eventType.runCompleted({
          runId,
          bot: actualProvider,
          chatId: input.session.sessionId,
          chatKey: input.session.conversationId,
          text: result.text,
          sessionId: result.sessionId,
          ...(result.telemetry ? { telemetry: result.telemetry } : {}),
        }));
      }
      eventStore.finalize();
      return { stopReason: cancelled ? "cancelled" : normalizeStopReason(result.stopReason) };
    } catch (error) {
      if (active?.cancelRequested) {
        if (eventStore && db.getRun(runId)?.status === "running") {
          eventStore.collect(cancelledEvent(runId, provider, input.session, "user"));
          eventStore.finalize();
        }
        return { stopReason: "cancelled" };
      }
      if (eventStore && db.getRun(runId)?.status === "running") {
        eventStore.collect(failedEvent(runId, provider, input.session));
        eventStore.finalize();
      }
      if (error instanceof acp.RequestError) throw error;
      throw new acp.RequestError(
        OUTWARD_ACP_EXECUTION_ERROR,
        "outward ACP prompt execution failed",
        { sessionId: input.session.sessionId, runId },
      );
    } finally {
      if (signalAbort) input.signal.removeEventListener("abort", signalAbort);
      if (active && this.active.get(input.session.conversationId) === active) {
        this.active.delete(input.session.conversationId);
      }
      try {
        db.unlock(lane);
      } finally {
        if (active) {
          active.settled = true;
          active.finishDone();
        }
      }
    }
  }
}

const NO_DELIVERY_PLATFORM: MessagingPlatform = {
  capabilities: SAFE_SURFACE_CAPABILITIES,
  async sendMessage() { return {}; },
  async editMessageText() { return {}; },
  async sendChatAction() { return {}; },
  async answerCallbackQuery() { return {}; },
  async setMyCommands() { return {}; },
  async sendDocument() {},
  async sendPhoto() {},
};

/**
 * Ordered inward provider chain for outward ACP execution. A provider lock
 * (dedicated single-provider systemd unit) yields a single-entry chain --
 * the router still works, it just never has anywhere to fall back to.
 */
function configuredProviderChain(env: NodeJS.ProcessEnv): readonly BotKind[] {
  const allowed = interactiveChainKinds() as BotKind[];
  const locked = env.BRIDGE_PROVIDER_LOCK?.trim();
  if (locked) {
    if (!allowed.includes(locked as BotKind)) {
      throw new Error(`unsupported outward ACP provider lock: ${locked}`);
    }
    return [locked as BotKind];
  }
  const fallback = (["codex", "claude", "grok", "antigravity", "cursor"] as BotKind[])
    .filter((kind) => allowed.includes(kind));
  const chain = parseCliChain(env.INTERACTIVE_CLI_CHAIN, { allowed, fallback });
  if (chain.length === 0) throw new Error("no interactive provider is configured for outward ACP");
  return chain;
}

export function createProductionOutwardAcpPromptExecutor(
  db: BridgeDb,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): BridgeOutwardAcpPromptExecutor {
  const providerChain = configuredProviderChain(env);
  const bots = loadBotsConfig(env);
  const allowedUserIds = new Set<string>();
  return new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain,
    createEngine: (session, attemptProvider) => {
      const executionMode = resolveExecutionMode(attemptProvider, env);
      const fullConfig: BridgeConfig = {
        allowedUserIds,
        serviceEnvFile: env.BRIDGE_ENV_FILE ?? null,
        serviceKind: attemptProvider,
        pollIntervalMs: 1000,
        executionMode,
        dbPath,
        bots,
      };
      const engine = new BridgeEngine({
        kind: attemptProvider,
        surfaceIdentity: OUTWARD_ACP_SURFACE,
        executionKind: attemptProvider,
        botConfig: bots[attemptProvider],
        allowedUserIds,
        executionMode,
        pollIntervalMs: 1000,
        workingDir: session.cwd,
        fullConfig,
      }, db, NO_DELIVERY_PLATFORM);
      return {
        // Each fallback candidate has its own distinct provider-session
        // binding (acp_session_bindings keyed by provider); resolve it fresh
        // per attempt rather than trusting whatever sessionId the router
        // forwards for a different provider's turn input.
        executeSurfaceNeutralTurn: (turnInput) => engine.executeSurfaceNeutralTurn({
          ...turnInput,
          sessionId: lookupProviderSession(db, session.conversationId, attemptProvider),
        }),
      };
    },
  });
}
