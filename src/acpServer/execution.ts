import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { abortCliProcessAndWait, toUserMessage } from "../cli.js";
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
import { createSurfaceNeutralProviderRouter, type SurfaceNeutralProviderRouter } from "../surfaceNeutralProviderRouter.js";
import { getCachedAvailableCliKinds } from "../interactiveCliAuth.js";
import { applyManualCliSwitchHandoff, getStoredCliPreference, type CliKind } from "../interactiveBot.js";
import type { BotKind, BridgeConfig, CliResult, RouteableBotKind } from "../types.js";

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
  attachments?: string[];
  signal: AbortSignal;
  onUpdate: (update: OutwardUpdate) => void | Promise<void>;
}

export interface OutwardAcpPromptExecutor {
  execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse>;
  cancel(session: OutwardAcpSessionRecord): Promise<void>;
}

/** Truthful Workstream state, derived only from durable Run records (#1101). */
export type OutwardWorkstreamState = "running" | "attention" | "failed" | "cancelled" | "idle";

export interface OutwardWorkstreamStatus {
  state: OutwardWorkstreamState;
  /** Durable per-Workstream selection (the chain head when none was chosen). */
  selectedProvider: BotKind;
  /**
   * Provider the next Run starts with. Differs from the selection after an
   * in-process fallback; a restart returns to the selection.
   */
  nextProvider: BotKind;
  /** Configured chain members, with current routeability. */
  providers: Array<{ id: BotKind; available: boolean }>;
  lastRun: {
    runId: string;
    provider: string;
    status: string;
    outcome: "complete" | "continue" | "blocked" | null;
    error: string | null;
    startedAt: string;
    endedAt: string | null;
  } | null;
}

/** Bridge-owned Workstream controls offered beside standard ACP. */
export interface OutwardWorkstreamControl {
  status(session: OutwardAcpSessionRecord): OutwardWorkstreamStatus;
  selectProvider(session: OutwardAcpSessionRecord, provider: string): OutwardWorkstreamStatus;
}

export type OutwardAcpExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export interface BridgeOutwardAcpPromptExecutorOptions {
  db: BridgeDb;
  /** Ordered fallback chain; [0] is the initial/head provider for a fresh session. */
  providerChain: readonly BotKind[];
  isProviderAvailable?: (provider: BotKind) => boolean;
  createEngine: (session: OutwardAcpSessionRecord, attemptProvider: BotKind) => OutwardAcpExecutionEngine;
  runId?: () => string;
  /** Fresh read-only side question for /btw; absent when not wired. */
  btw?: (session: OutwardAcpSessionRecord, provider: BotKind, prompt: string) => Promise<string>;
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
 *
 * This is protocol forwarding: non-text updates pass through unmodified and
 * provider message chunks are never rewritten. Paragraph rendering of
 * logical messages (src/acp/logicalMessages.ts) belongs to the human-readable
 * answer selected upstream, not to raw ACP chunks.
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

function failedEvent(runId: string, provider: RouteableBotKind, session: OutwardAcpSessionRecord): BridgeEvent {
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
  provider: RouteableBotKind,
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

export class BridgeOutwardAcpPromptExecutor implements OutwardAcpPromptExecutor, OutwardWorkstreamControl {
  private readonly active = new Map<string, ActiveOutwardExecution>();
  // One router per conversation, reused across turns so that a fallback
  // chosen on an earlier turn stays the active provider on later turns
  // (matches Telegram's per-chat ProviderFallbackChain lifetime) rather than
  // silently retrying an already-exhausted head provider every turn.
  // A router is rebuilt only when the Workstream's durable provider selection
  // changes, which can only happen while no Run holds the conversation lane.
  private readonly routers = new Map<string, { provider: BotKind; router: SurfaceNeutralProviderRouter }>();

  constructor(private readonly options: BridgeOutwardAcpPromptExecutorOptions) {}

  private identity(session: OutwardAcpSessionRecord) {
    return { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId };
  }

  /** Durable per-Workstream selection when it is still in the chain, else the chain head. */
  private selectedProvider(session: OutwardAcpSessionRecord): BotKind {
    const stored = getStoredCliPreference(this.options.db, this.identity(session));
    return stored && this.options.providerChain.includes(stored as BotKind) ? stored as BotKind : this.options.providerChain[0];
  }

  private routerFor(session: OutwardAcpSessionRecord, initialProvider: BotKind): SurfaceNeutralProviderRouter {
    const existing = this.routers.get(session.conversationId);
    if (existing?.provider === initialProvider) return existing.router;
    const { db, providerChain, createEngine, isProviderAvailable } = this.options;
    const router = createSurfaceNeutralProviderRouter({
      db,
      isProviderAvailable,
      surfaceIdentity: OUTWARD_ACP_SURFACE,
      initialProvider,
      providerChain,
      engineForProvider: (attemptProvider) => createEngine(session, attemptProvider),
    });
    this.routers.set(session.conversationId, { provider: initialProvider, router });
    return router;
  }

  status(session: OutwardAcpSessionRecord): OutwardWorkstreamStatus {
    const { db, providerChain, isProviderAvailable } = this.options;
    const run = db.getLatestRunForConversation(this.identity(session));
    let state: OutwardWorkstreamState = "idle";
    if (run?.status === "running") state = "running";
    else if (run?.status === "failed") state = "failed";
    else if (run?.status === "cancelled") state = "cancelled";
    // Attention comes only from an explicit recorded provider disposition.
    else if (run?.outcome_status === "blocked") state = "attention";
    const selectedProvider = this.selectedProvider(session);
    const cached = this.routers.get(session.conversationId);
    return {
      state,
      selectedProvider,
      nextProvider: cached?.provider === selectedProvider ? cached.router.activeProvider(session.conversationId) : selectedProvider,
      providers: providerChain.map((id) => ({ id, available: isProviderAvailable?.(id) ?? true })),
      lastRun: run ? {
        runId: run.run_id,
        provider: run.bot,
        status: run.status,
        outcome: run.outcome_status,
        error: run.error ? (run.status === "cancelled" && run.error === "user"
          ? "Run cancelled by user."
          : run.status === "cancelled" ? "Run cancelled."
            : toUserMessage(new Error(run.error))) : null,
        startedAt: run.started_at,
        endedAt: run.ended_at,
      } : null,
    };
  }

  /**
   * Durable per-Workstream provider switch. Holds the conversation lane for
   * the write, so it never retargets an in-flight Run: a busy Workstream
   * fails transparently and the caller may retry after the Run settles.
   */
  selectProvider(session: OutwardAcpSessionRecord, provider: string): OutwardWorkstreamStatus {
    const { db, providerChain, isProviderAvailable } = this.options;
    const target = providerChain.find((candidate) => candidate === provider);
    if (!target) {
      throw acp.RequestError.invalidParams({ field: "provider" }, "provider is not configured for this workspace");
    }
    if (isProviderAvailable && !isProviderAvailable(target)) {
      throw acp.RequestError.invalidParams({ field: "provider" }, "provider is not installed or authenticated");
    }
    this.withIdleLane(session, () => {
      if (this.selectedProvider(session) !== target) {
        applyManualCliSwitchHandoff(db, this.identity(session), target as CliKind);
        this.routers.delete(session.conversationId);
      }
    });
    return this.status(session);
  }

  /** Run a Workstream mutation under its lane fence; busy when a Run holds the lane. */
  withIdleLane<T>(session: OutwardAcpSessionRecord, operation: () => T): T {
    const { db } = this.options;
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId);
    if (!lane) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP session is busy", { sessionId: session.sessionId });
    }
    try {
      return db.runWithLockFence(lane, operation);
    } finally {
      db.unlock(lane);
    }
  }

  get btw(): ((session: OutwardAcpSessionRecord, provider: BotKind, prompt: string) => Promise<string>) | undefined {
    return this.options.btw;
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
    const { db } = this.options;
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, input.session.conversationId);
    if (!lane) {
      throw new acp.RequestError(
        OUTWARD_ACP_BUSY_ERROR,
        "outward ACP session is busy",
        { sessionId: input.session.sessionId },
      );
    }

    const provider = this.selectedProvider(input.session);
    const runId = this.options.runId?.() ?? randomUUID();
    let eventStore: EventStore | null = null;
    let active: ActiveOutwardExecution | null = null;
    let signalAbort: (() => void) | null = null;
    let activeProvider: RouteableBotKind = provider;
    try {
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: input.session.conversationId };
      db.runInTransaction(() => {
        db.insertRun(runId, identity, provider);
        // An admitted prompt is durable even if its provider turn fails or the
        // process restarts before a final answer exists.
        db.addConvTurn(input.session.conversationId, "user", input.prompt, provider, {
          surfaceIdentity: OUTWARD_ACP_SURFACE,
        });
      });
      eventStore = new EventStore(db, identity, runId);

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
        if (event.type === "run.started") activeProvider = event.bot;
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

      const result: CliResult = await this.routerFor(input.session, provider).executeSurfaceNeutralTurn({
        prompt: input.prompt,
        attachments: input.attachments ?? [],
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
      // terminal event, or at minimum the latest surviving run.started event.
      const terminalBot = (event: { bot: RouteableBotKind } | null): RouteableBotKind | undefined => event?.bot;
      const actualProvider: RouteableBotKind = terminalBot(completed) ?? terminalBot(providerCancelled) ?? activeProvider;
      db.runWithLockFence(lane, () => {
        persistProviderSession(db, { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: input.session.conversationId }, actualProvider, result.sessionId, runId);
      });

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
      db.runWithLockFence(lane, () => db.runInTransaction(() => {
        if (!cancelled && result.text) {
          db.addConvTurn(input.session.conversationId, "assistant", result.text, actualProvider, {
            surfaceIdentity: OUTWARD_ACP_SURFACE,
          });
        }
        eventStore!.finalize();
        if (db.getRun(runId)?.status !== (cancelled ? "cancelled" : "done")) {
          throw new Error("outward ACP terminal Run state was not persisted");
        }
      }));
      if (!cancelled && result.text) {
        await input.onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        });
      }
      return { stopReason: cancelled ? "cancelled" : normalizeStopReason(result.stopReason) };
    } catch (error) {
      if (active?.cancelRequested) {
        if (eventStore && db.getRun(runId)?.status === "running") {
          eventStore.collect(cancelledEvent(runId, activeProvider, input.session, "user"));
          eventStore.finalize();
        }
        return { stopReason: "cancelled" };
      }
      if (eventStore && db.getRun(runId)?.status === "running") {
        eventStore.collect(failedEvent(runId, activeProvider, input.session));
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
/**
 * "custom-acp" has no fixed CLI binary: interactive chat surfaces load its
 * command/model per conversation via slash commands
 * (interactiveAcpConfig.ts). Outward ACP builds one BridgeEngine per
 * provider for the whole process from a static loadBotsConfig() lookup,
 * which has no "custom-acp" entry and no per-session config channel — so it
 * must never be selected here. Fail closed before admission rather than
 * construct a BridgeEngine with an undefined bot config (#1114 gap item 7).
 */
function configuredProviderChain(env: NodeJS.ProcessEnv): readonly BotKind[] {
  const allowed = (interactiveChainKinds() as RouteableBotKind[]).filter((kind): kind is BotKind => kind !== "custom-acp");
  const locked = env.BRIDGE_PROVIDER_LOCK?.trim();
  if (locked) {
    if (locked === "custom-acp") {
      throw new Error("outward ACP does not support a custom-acp provider lock: no per-session ACP configuration exists outside interactive chat chains");
    }
    if (!allowed.includes(locked as BotKind)) {
      throw new Error(`unsupported outward ACP provider lock: ${locked}`);
    }
    return [locked as BotKind];
  }
  const fallback = (["codex", "claude", "antigravity", "grok", "cursor"] as BotKind[])
    .filter((kind) => allowed.includes(kind));
  const chain = parseCliChain(env.INTERACTIVE_CLI_CHAIN, { allowed, fallback });
  if (chain.length === 0) throw new Error("no interactive provider is configured for outward ACP");
  return chain;
}

/** Settings view for outward Desk commands (/models reads provider bot config). */
export function outwardCommandConfig(dbPath: string, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const head = configuredProviderChain(env)[0];
  return {
    allowedUserIds: new Set<string>(),
    serviceEnvFile: env.BRIDGE_ENV_FILE ?? null,
    serviceKind: head,
    pollIntervalMs: 1000,
    executionMode: resolveExecutionMode(head, env),
    dbPath,
    bots: loadBotsConfig(env),
  };
}

export function createProductionOutwardAcpPromptExecutor(
  db: BridgeDb,
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): BridgeOutwardAcpPromptExecutor {
  const providerChain = configuredProviderChain(env);
  const bots = loadBotsConfig(env);
  const allowedUserIds = new Set<string>();
  const buildEngine = (session: OutwardAcpSessionRecord, attemptProvider: BotKind): BridgeEngine => {
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
    return new BridgeEngine({
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
  };
  return new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain,
    isProviderAvailable: (provider) => getCachedAvailableCliKinds({ env }).has(provider as CliKind),
    btw: (session, provider, prompt) => buildEngine(session, provider).executeSurfaceNeutralBtw(prompt, session.conversationId),
    createEngine: (session, attemptProvider) => {
      const engine = buildEngine(session, attemptProvider);
      return {
        // Each fallback candidate has its own distinct provider-session
        // binding (acp_session_bindings keyed by provider); resolve it fresh
        // per attempt rather than trusting whatever sessionId the router
        // forwards for a different provider's turn input.
        executeSurfaceNeutralTurn: (turnInput) => engine.executeSurfaceNeutralTurn({
          ...turnInput,
          sessionId: lookupProviderSession(db, { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: session.conversationId }, attemptProvider),
        }),
      };
    },
  });
}
