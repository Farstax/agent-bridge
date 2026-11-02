import * as acp from "@agentclientprotocol/sdk/unstable";
import { randomUUID } from "node:crypto";
import { abortCliProcessAndWait, toUserMessage } from "../cli.js";
import { loadBotsConfig, resolveExecutionMode } from "../config.js";
import type { BridgeDb } from "../db.js";
import type { ExecutionLaneHandle } from "../db.js";
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
import { readRetainedOutwardAcpAttachments, retainOutwardAcpAttachmentsForWait, releaseRetainedOutwardAcpAttachments } from "./attachments.js";
import { resolveLaneBusyMessageMode } from "../busyMessageMode.js";
import { hasPendingCapacityWait, listRunContinuations, linkCapacityContinuationRun, requestRunContinuation, cancelPendingRunContinuation, type RunContinuation } from "../runContinuation.js";


import { OUTWARD_ACP_SURFACE, recoverOutwardLanes } from "./recovery.js";
export { OUTWARD_ACP_SURFACE } from "./recovery.js";
const OUTWARD_ACP_EXECUTION_ERROR = -32001;
const OUTWARD_ACP_BUSY_ERROR = -32002;
const CANCELLATION_SWEEP_MS = 10;
/** Same bound the messaging engines apply to a lane's durable queue. */
const OUTWARD_QUEUE_MAX_DEPTH = 5;
const REMOTE_STOP_POLL_MS = 200;
const REMOTE_STOP_WAIT_MS = 5_000;
const QUEUE_CAPACITY_RETRIES = 5;
const QUEUE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETAINED_ATTACHMENT_MARKER = "acp-retained:";

/** Internal-only: bounded requeue permitted after a verified capacity rejection. */
export class OutwardCapacityRetry extends Error {
  constructor() { super("outward provider capacity temporarily exhausted"); this.name = "OutwardCapacityRetry"; }
}

type OutwardUpdate = acp.SessionNotification["update"];
type RunCancelledEvent = Extract<BridgeEvent, { type: "run.cancelled" }>;

type ActiveOutwardExecution = {
  readonly session: OutwardAcpSessionRecord;
  cancelRequested: boolean;
  cancelPromise: Promise<void> | null;
  settled: boolean;
  readonly lane: ExecutionLaneHandle;
  readonly provider: RouteableBotKind;
  readonly done: Promise<void>;
  readonly finishDone: () => void;
};

export interface OutwardAcpPromptExecutionInput {
  session: OutwardAcpSessionRecord;
  prompt: string;
  attachments?: string[];
  runId?: string;
  signal: AbortSignal;
  onUpdate: (update: OutwardUpdate) => void | Promise<void>;
  /** ACP v1 caller opted into the deferred capacity extension. */
  deferCapacity?: boolean;
  /** Trusted, claimed continuation only; not supplied by an ACP client. */
  capacityResume?: { id: string; claimToken: string };
  /** ACP v1 caller opted into busy-message admission; otherwise a busy Workstream fails fast. */
  busyMessages?: boolean;
  /** Client idempotency token; a repeated submission never creates a second queue row or Run. */
  requestId?: string;
}

/** A durably queued message claimed by the lane owner for execution. */
type QueuedExecution = {
  id: number;
  key: string;
  retainedId: string | null;
  requeued: boolean;
};

export interface OutwardAcpPromptExecutor {
  execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse>;
  cancel(session: OutwardAcpSessionRecord): Promise<void>;
  readonly supportsDeferredCapacity?: boolean;
  readonly supportsBusyMessages?: boolean;
}

/** Truthful Workstream state, derived only from durable Run records (#1101). */
export type OutwardWorkstreamState = "running" | "waiting" | "attention" | "failed" | "cancelled" | "expired" | "idle";

export interface OutwardWorkstreamStatus {
  state: OutwardWorkstreamState;
  /** Durably accepted messages that have not started executing (busy-message queue). */
  queued: number;
  /** Durable per-Workstream selection (the chain head when none was chosen). */
  selectedProvider: BotKind;
  /**
   * Provider the next Run starts with. Differs from the selection after an
   * in-process fallback; a restart returns to the selection.
   */
  nextProvider: BotKind | null;
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
  /** Read shared durable continuation state once when projecting a Workstream list. */
  statusMany?(sessions: readonly OutwardAcpSessionRecord[]): OutwardWorkstreamStatus[];
  selectProvider(session: OutwardAcpSessionRecord, provider: string): OutwardWorkstreamStatus;
  cancelDeferred?(session: OutwardAcpSessionRecord): Promise<OutwardWorkstreamStatus>;
}

export type OutwardAcpExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn">;

export interface BridgeOutwardAcpPromptExecutorOptions {
  db: BridgeDb;
  /** Ordered fallback chain; [0] is the initial/head provider for a fresh session. */
  providerChain: readonly BotKind[];
  isProviderAvailable?: (provider: BotKind) => boolean;
  /** Fresh provider availability for one status projection, avoiding repeated full probes. */
  getAvailableProviders?: () => ReadonlySet<BotKind>;
  createEngine: (session: OutwardAcpSessionRecord, attemptProvider: BotKind) => OutwardAcpExecutionEngine;
  runId?: () => string;
  /** Enabled only with an independently supervised workspace continuation owner. */
  enableDeferredCapacity?: boolean;
  /** Resolves a queued message's Workstream when a supervised owner drains the durable queue. */
  lookupSession?: (sessionId: string) => OutwardAcpSessionRecord | null;
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

  get supportsDeferredCapacity(): boolean { return this.options.enableDeferredCapacity === true; }
  readonly supportsBusyMessages = true;
  private closing = false;
  private readonly draining = new Set<string>();

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
    const continuations = listRunContinuations(this.options.db, OUTWARD_ACP_SURFACE)
      .filter((item) => item.chatKey === session.conversationId && item.outward?.sessionId === session.sessionId);
    return this.statusWithContinuations(session, continuations, this.availableProviderSnapshot(),
      this.options.db.pendingMsgQueuedCount(OUTWARD_ACP_SURFACE, session.conversationId));
  }

  statusMany(sessions: readonly OutwardAcpSessionRecord[]): OutwardWorkstreamStatus[] {
    if (sessions.length === 0) return [];
    const availableProviders = this.availableProviderSnapshot();
    const queuedCounts = this.options.db.pendingMessageCounts(OUTWARD_ACP_SURFACE);
    const byWorkstream = new Map<string, RunContinuation[]>();
    for (const item of listRunContinuations(this.options.db, OUTWARD_ACP_SURFACE)) {
      const sessionId = item.outward?.sessionId;
      if (!sessionId) continue;
      const key = `${item.chatKey}\0${sessionId}`;
      const group = byWorkstream.get(key);
      if (group) group.push(item);
      else byWorkstream.set(key, [item]);
    }
    return sessions.map((session) => this.statusWithContinuations(
      session,
      byWorkstream.get(`${session.conversationId}\0${session.sessionId}`) ?? [],
      availableProviders,
      queuedCounts.get(session.conversationId) ?? 0,
    ));
  }

  private availableProviderSnapshot(): ReadonlySet<BotKind> | null {
    return this.options.getAvailableProviders?.() ?? null;
  }

  private statusWithContinuations(
    session: OutwardAcpSessionRecord,
    continuations: readonly RunContinuation[],
    availableProviders: ReadonlySet<BotKind> | null,
    queued: number,
  ): OutwardWorkstreamStatus {
    const { db, providerChain, isProviderAvailable } = this.options;
    const providerIsAvailable = (provider: BotKind): boolean => availableProviders
      ? availableProviders.has(provider)
      : isProviderAvailable?.(provider) ?? true;
    const latest = db.getLatestRunForConversation(this.identity(session));
    const allWaits = [...continuations].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    const lastWait = allWaits.at(-1);
    const wait = allWaits.find((item) => item.state === "pending" || item.state === "claimed");
    // A waiting deferred Run owns the Workstream even though its original
    // capacity-rejected attempt has a terminal failed event.
    const run = wait && latest?.status !== "running" ? db.getRun(wait.originRunId) : latest;
    let state: OutwardWorkstreamState = "idle";
    if (latest?.status === "running") state = "running";
    else if (wait) state = "waiting";
    else if (lastWait?.state === "cancelled" && latest?.run_id === lastWait.originRunId) state = "cancelled";
    else if (lastWait?.state === "expired" && (latest?.run_id === lastWait.originRunId || latest?.run_id === lastWait.successorRunId)) state = "expired";
    else if (run?.status === "failed") state = "failed";
    else if (run?.status === "cancelled") state = "cancelled";
    // Attention comes only from an explicit recorded provider disposition.
    else if (run?.outcome_status === "blocked") state = "attention";
    const selectedProvider = this.selectedProvider(session);
    const cached = this.routers.get(session.conversationId);
    return {
      state,
      queued,
      selectedProvider,
      nextProvider: cached?.provider === selectedProvider ? cached.router.activeProvider(session.conversationId)
        : [selectedProvider, ...providerChain.filter((provider) => provider !== selectedProvider)]
          .find(providerIsAvailable) ?? null,
      providers: providerChain.map((id) => ({ id, available: providerIsAvailable(id) })),
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

  /** Cancel a durably waiting task, never an already-claimed active provider.
   * The ACP v1 session/cancel notification only cancels a live request.
   */
  async cancelDeferred(session: OutwardAcpSessionRecord): Promise<OutwardWorkstreamStatus> {
    const { db } = this.options;
    const wait = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) =>
      item.chatKey === session.conversationId && item.outward?.sessionId === session.sessionId
      && (item.state === "pending" || item.state === "claimed"));
    if (!wait) throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "no pending deferred Workstream task");
    if (wait.state !== "pending") {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "the deferred provider is already executing; cancellation requires active process containment");
    }
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId);
    if (!lane) throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "deferred Workstream is busy");
    try {
      const cancelled = db.runWithLockFence(lane, () => db.runInTransaction(() => {
        // Read the same durable row under the transaction that changes it;
        // the worker's compare-and-swap claim may have won before this point.
        const current = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wait.id);
        return current?.state === "pending" && cancelPendingRunContinuation(db, wait.id, "cancelled_by_owner");
      }));
      if (!cancelled) {
        throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "deferred capacity task was already claimed");
      }
    } finally { db.unlock(lane); }
    await releaseRetainedOutwardAcpAttachments(session.cwd, wait.id);
    return this.status(session);
  }

  /** Run a Workstream mutation under its lane fence; busy when a Run holds the lane. */
  withIdleLane<T>(session: OutwardAcpSessionRecord, operation: () => T): T {
    const { db } = this.options;
    if (hasPendingCapacityWait(db, OUTWARD_ACP_SURFACE, session.conversationId)) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Workstream has a deferred task", { sessionId: session.sessionId });
    }
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId, false);
    if (!lane) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP session is busy", { sessionId: session.sessionId });
    }
    try {
      if (db.listRunningRuns(OUTWARD_ACP_SURFACE).some((run) => run.chat_id === session.conversationId)) {
        throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP session is busy", { sessionId: session.sessionId });
      }
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
    if (!record) return this.requestRemoteStop(session);
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
    this.closing = true;
    const records = [...this.active.values()];
    await Promise.all(records.map(async (record) => {
      await this.cancel(record.session);
      await record.done;
    }));
  }

  async execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse> {
    const { db } = this.options;
    if (hasPendingCapacityWait(db, OUTWARD_ACP_SURFACE, input.session.conversationId, input.capacityResume?.id)) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Workstream is awaiting provider capacity");
    }
    // Only a client that opted into the advertised busy-message extension may
    // submit during an active Run; every other client keeps ACP v1 fail-fast.
    const optedIn = input.busyMessages === true && !input.capacityResume;
    const conversationId = input.session.conversationId;
    if (optedIn && input.requestId) {
      const replay = this.replayRequest(input.session, input.requestId);
      if (replay) return replay;
    }
    const requestToken = optedIn && input.requestId ? randomUUID() : null;
    const reservationKey = input.requestId ? queueReservationKey(requestKey(input.session, input.requestId)) : null;
    const acquire = () => requestToken && input.requestId && reservationKey
      ? db.acquireLaneForIdempotentRequest(
        OUTWARD_ACP_SURFACE, conversationId, requestKey(input.session, input.requestId),
        reservationKey, queueReceiptKey(requestKey(input.session, input.requestId)),
        queueRunLinkKey(requestKey(input.session, input.requestId)), requestToken,
      )
      : db.acquireLock(OUTWARD_ACP_SURFACE, conversationId, false);
    try {
      let lane = acquire();
      if (!lane && !this.hasRunningRun(conversationId) &&
          !(reservationKey && db.getSetting(reservationKey))) {
        await recoverOutwardLanes(db);
        lane = acquire();
      }
      if (lane && (this.hasRunningRun(conversationId) ||
          // Accepted earlier messages keep their order ahead of a new submission.
          (optedIn && db.pendingMsgCount(OUTWARD_ACP_SURFACE, conversationId) > 0))) {
        db.unlock(lane);
        lane = null;
      }
      if (!lane) {
        if (optedIn) return this.queueBehindActive(input, requestToken ?? undefined);
        throw new acp.RequestError(
          OUTWARD_ACP_BUSY_ERROR,
          "outward ACP session is busy",
          { sessionId: input.session.sessionId },
        );
      }
      return await this.runOnLane(input, lane, undefined, requestToken ?? undefined);
    } finally {
      if (requestToken && reservationKey && db.getSetting(reservationKey) === requestToken) {
        db.setSetting(reservationKey, null);
      }
    }
  }

  /** Answer a repeated client request from durable state; never admit it twice. */
  private replayRequest(session: OutwardAcpSessionRecord, requestId: string): acp.PromptResponse | null {
    const { db } = this.options;
    const key = requestKey(session, requestId);
    const settled = db.getSetting(queueReceiptKey(key));
    if (settled) return this.queueReceipt("settled", { requestId, ...JSON.parse(settled) });
    const queuedId = db.getPendingMessageIdByCorrelationKey(OUTWARD_ACP_SURFACE, key);
    if (queuedId !== null) {
      const position = db.pendingMessagePosition(OUTWARD_ACP_SURFACE, session.conversationId, queuedId);
      if (position === 0) {
        const runId = db.getSetting(queueRunLinkKey(key));
        const run = runId ? db.getRun(runId) : null;
        if (run?.status === "running") return this.queueReceipt("running", { requestId, runId });
        return this.queueReceipt("running", { requestId, ...(runId ? { runId } : {}) });
      }
      return this.queueReceipt("queued", {
        queueId: queuedId, mode: this.busyMode(session), requestId,
        position,
      });
    }
    const linkedRun = db.getSetting(queueRunLinkKey(key));
    if (!linkedRun) return null;
    const run = db.getRun(linkedRun);
    if (run?.status === "running") return this.queueReceipt("running", { requestId, runId: linkedRun });
    this.writeQueueReceipt(key, { status: run?.status ?? "failed", runId: linkedRun });
    db.setSetting(queueRunLinkKey(key), null);
    return this.queueReceipt("settled", { requestId, status: run?.status ?? "failed", runId: linkedRun });
  }

  private hasRunningRun(conversationId: string): boolean {
    return this.options.db.listRunningRuns(OUTWARD_ACP_SURFACE).some((run) => run.chat_id === conversationId);
  }

  /** Execute one prompt under an already-acquired lane; always releases the lane. */
  private async runOnLane(
    input: OutwardAcpPromptExecutionInput,
    lane: ExecutionLaneHandle,
    queued?: QueuedExecution,
    reservationToken?: string,
  ): Promise<acp.PromptResponse> {
    const { db } = this.options;
    const idempotencyKey = queued?.key
      ?? (input.busyMessages === true && input.requestId ? requestKey(input.session, input.requestId) : null);
    const provider = this.selectedProvider(input.session);
    const runId = input.runId ?? this.options.runId?.() ?? randomUUID();
    let eventStore: EventStore | null = null;
    let active: ActiveOutwardExecution | null = null;
    let signalAbort: (() => void) | null = null;
    let stopPoll: NodeJS.Timeout | null = null;
    let activeProvider: RouteableBotKind = provider;
    let encounteredCapacity = false;
    let queueCapacityRequeue = false;
    let recoveryChainExhausted = false;
    try {
      const identity = { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: input.session.conversationId };
      db.runInTransaction(() => {
        db.insertRun(runId, identity, provider);
        // Persist the Run -> queued row link with the Run, so a crash after this
        // point can never replay a prompt whose execution may have started.
        if (idempotencyKey) {
          db.setSetting(queueRunLinkKey(idempotencyKey), runId);
          if (reservationToken) db.setSetting(queueReservationKey(idempotencyKey), null);
        }
        if (input.capacityResume) {
          // Persist the exact continuation claim -> successor link before any
          // provider can execute, so a crash cannot lead to blind replay.
          if (!linkCapacityContinuationRun(db, input.capacityResume.id, input.capacityResume.claimToken, runId)) {
            throw new Error("outward ACP capacity continuation claim was lost");
          }
        } else {
          // A resumed turn must never append the original user request again.
          db.addConvTurn(input.session.conversationId, "user", input.prompt, provider, {
            surfaceIdentity: OUTWARD_ACP_SURFACE,
          });
        }
      });
      eventStore = new EventStore(db, identity, runId);

      let finishDone!: () => void;
      const done = new Promise<void>((resolve) => { finishDone = resolve; });
      active = {
        session: input.session,
        cancelRequested: input.signal.aborted,
        cancelPromise: null,
        settled: false,
        lane,
        provider,
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
      // A Stop from another ACP process cannot reach this process's memory; it
      // leaves a durable request keyed by this exact Run, observed here.
      stopPoll = setInterval(() => {
        try {
          if (db.getSetting(remoteStopKey(runId))) {
            void this.cancel(input.session).catch(() => console.warn("[acp:outward] remote stop cleanup failed"));
          }
        } catch { /* a transient read failure is retried on the next tick */ }
      }, REMOTE_STOP_POLL_MS);
      stopPoll.unref();

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
        onProviderRecoveryDecision: (reason, exhausted) => {
          if (reason === "capacity") encounteredCapacity = true;
          if (exhausted) recoveryChainExhausted = true;
        },
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
      // A standard ACP client has no deferred-result semantics. Only clients
      // that explicitly opted in, and only when the independently supervised
      // workspace worker is enabled, may receive a durable waiting outcome.
      const capacityWaitEligible = recoveryChainExhausted && encounteredCapacity;
      if (queued && capacityWaitEligible && !active?.cancelRequested) queueCapacityRequeue = true;
      if (input.capacityResume && capacityWaitEligible && !active?.cancelRequested) {
        // The continuation runner, not this request, owns the retry schedule.
        throw new OutwardCapacityRetry();
      }
      if (input.deferCapacity && this.supportsDeferredCapacity && !input.capacityResume && !active?.cancelRequested &&
          capacityWaitEligible) {
        const continuationId = `acp-capacity-wait:${runId}`;
        await retainOutwardAcpAttachmentsForWait(input.session.cwd, input.attachments ?? [], continuationId);
        try {
          requestRunContinuation(db, {
            continuationId,
            originRunId: runId,
            surfaceIdentity: OUTWARD_ACP_SURFACE,
            chatKey: input.session.conversationId,
            provider: activeProvider,
            reason: "configured providers at capacity or requiring authentication",
            afterSeconds: 300,
            capacityWait: true,
            outward: { sessionId: input.session.sessionId, prompt: input.prompt, attachmentCount: input.attachments?.length ?? 0 },
          });
        } catch (persistError) {
          // Leave a short-lived orphan for the bounded owner-marker cleanup;
          // never signal deferred admission if its durable record was not made.
          throw persistError;
        }
        return { stopReason: "end_turn", _meta: { "agent-bridge": { outcome: "deferred", runId } } };
      }
      if (error instanceof acp.RequestError) throw error;
      throw new acp.RequestError(
        OUTWARD_ACP_EXECUTION_ERROR,
        "outward ACP prompt execution failed",
        { sessionId: input.session.sessionId, runId },
      );
    } finally {
      if (signalAbort) input.signal.removeEventListener("abort", signalAbort);
      if (stopPoll) {
        clearInterval(stopPoll);
        try { db.setSetting(remoteStopKey(runId), null); } catch { /* expiry sweep removes it */ }
      }
      if (active && this.active.get(input.session.conversationId) === active) {
        this.active.delete(input.session.conversationId);
      }
      try {
        // Settle the durable queue row while this process still owns the lane.
        if (queued) await this.settleQueued(lane, input.session, queued, runId, queueCapacityRequeue);
        else if (idempotencyKey) this.settleDirect(idempotencyKey, runId);
      } catch (error) {
        console.error("[acp:outward] queued message settlement failed", error);
      }
      try {
        db.unlock(lane);
      } finally {
        if (active) {
          active.settled = true;
          active.finishDone();
        }
        // Run the next accepted message once the lane is free; a closing
        // process leaves it durable for the supervised owner or next client.
        if (!this.closing && !queued?.requeued) this.scheduleDrain(input.session);
      }
    }
  }

  // ── Busy-message admission (#1130) ──────────────────────────────────────

  private busyMode(session: OutwardAcpSessionRecord) {
    return resolveLaneBusyMessageMode(this.options.db, OUTWARD_ACP_SURFACE, session.conversationId, "queue");
  }

  private queueReceipt(
    outcome: "queued" | "steered" | "settled" | "running",
    detail: Record<string, unknown>,
  ): acp.PromptResponse {
    return { stopReason: "end_turn", _meta: { "agent-bridge": { outcome, ...detail } } };
  }

  /**
   * Durably accept a message for a busy Workstream through the shared Bridge
   * admission primitive. Acceptance is not completion: the receipt names the
   * queue row, and execution is observable through Workstream status.
   */
  private async queueBehindActive(input: OutwardAcpPromptExecutionInput, reservationToken?: string): Promise<acp.PromptResponse> {
    const { db } = this.options;
    const { session } = input;
    const mode = this.busyMode(session);
    const key = input.requestId ? requestKey(session, input.requestId) : `acp-queue:${randomUUID()}`;
    const settled = db.getSetting(queueReceiptKey(key));
    if (settled) return this.queueReceipt("settled", { requestId: input.requestId, ...JSON.parse(settled) });
    const existing = db.getPendingMessageIdByCorrelationKey(OUTWARD_ACP_SURFACE, key);
    if (existing !== null) {
      const position = db.pendingMessagePosition(OUTWARD_ACP_SURFACE, session.conversationId, existing);
      if (position === 0) {
        const runId = db.getSetting(queueRunLinkKey(key));
        return this.queueReceipt("running", { requestId: input.requestId, ...(runId ? { runId } : {}) });
      }
      return this.queueReceipt("queued", {
        queueId: existing, mode,
        position,
        requestId: input.requestId,
      });
    }
    const attachments = input.attachments ?? [];
    // Each contender owns a private snapshot. The database transaction below
    // decides which snapshot belongs to the single accepted queue row.
    const retainedId = `acp-queue-${randomUUID()}`;
    if (attachments.length > 0) {
      // Own a private durable copy before acknowledging acceptance; the
      // request's ephemeral staging directory is removed when it returns.
      await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId);
      await retainOutwardAcpAttachmentsForWait(session.cwd, attachments, retainedId);
    }
    let admission: ReturnType<BridgeDb["admitQueuedMessageOnce"]>;
    try {
      admission = db.admitQueuedMessageOnce(OUTWARD_ACP_SURFACE, session.conversationId, {
        prompt: input.prompt,
        chatId: session.sessionId,
        chatType: "acp",
        attachments: attachments.length > 0 ? [`${RETAINED_ATTACHMENT_MARKER}${retainedId}`] : [],
        scheduledOccurrenceKey: key,
      }, OUTWARD_QUEUE_MAX_DEPTH, queueReceiptKey(key), queueRunLinkKey(key), queueReservationKey(key), reservationToken ?? "");
    } catch (error) {
      await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
      throw error;
    }
    if (admission.kind !== "queued") {
      await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
      if (admission.kind === "full") {
        throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP queue is full", { sessionId: session.sessionId });
      }
      if (admission.kind === "existing") {
        return this.queueReceipt("queued", {
          queueId: admission.id, mode, position: admission.position, requestId: input.requestId,
        });
      }
      if (admission.kind === "running") {
        return this.queueReceipt("running", { runId: admission.runId, requestId: input.requestId });
      }
      return this.queueReceipt("settled", { requestId: input.requestId, ...JSON.parse(admission.value) });
    }
    const queueId = admission.id;
    let steered = false;
    if (mode === "interrupt") await this.cancel(session);
    else if (mode === "augment") steered = await this.trySteerQueued(session, queueId);
    this.scheduleDrain(session);
    if (steered) return this.queueReceipt("steered", { queueId, mode, requestId: input.requestId });
    // The queue row may already be running or settled by the time we answer;
    // the receipt still reports acceptance, and status/history report progress.
    const position = db.pendingMessagePosition(OUTWARD_ACP_SURFACE, session.conversationId, queueId);
    if (position === 0) {
      const runId = db.getSetting(queueRunLinkKey(key));
      const run = runId ? db.getRun(runId) : null;
      if (run?.status === "running") return this.queueReceipt("running", { queueId, mode, requestId: input.requestId, runId });
      const settled = db.getSetting(queueReceiptKey(key));
      if (settled) return this.queueReceipt("settled", { requestId: input.requestId, ...JSON.parse(settled) });
      return this.queueReceipt("running", { queueId, mode, requestId: input.requestId });
    }
    return this.queueReceipt("queued", {
      queueId, mode, position,
      requestId: input.requestId,
    });
  }

  /**
   * Augment: inject into the live provider turn only when this process owns it
   * and the provider qualified for steering. Otherwise the message stays
   * durably queued (the documented safe fallback).
   */
  private async trySteerQueued(session: OutwardAcpSessionRecord, queueId: number): Promise<boolean> {
    const { db } = this.options;
    const record = this.active.get(session.conversationId);
    const steer = executionLaneCoordinator(db, OUTWARD_ACP_SURFACE).getSteerHandle(executionLane(session.conversationId));
    if (!record || !steer) return false;
    const claimed = db.claimPendingMsgs(record.lane, [queueId]);
    const row = claimed[0];
    if (!row) return false;
    if (row.attachments.length > 0 || !row.scheduledOccurrenceKey) {
      db.releasePendingClaim(record.lane, row.id);
      return false;
    }
    let outcome: { outcome: string } | null = null;
    try { outcome = await steer(row.prompt); } catch { outcome = null; }
    if (outcome?.outcome !== "injected") {
      db.releasePendingClaim(record.lane, row.id);
      return false;
    }
    // Delivered to the live turn: the row must never become claimable again.
    db.runInTransaction(() => {
      db.addConvTurn(session.conversationId, "user", row.prompt, record.provider, { surfaceIdentity: OUTWARD_ACP_SURFACE });
      db.deletePendingMsg(row.id);
      this.writeQueueReceipt(row.scheduledOccurrenceKey!, { status: "steered", runId: record.lane.runId });
    });
    return true;
  }

  private writeQueueReceipt(key: string, receipt: Record<string, unknown>): void {
    const { db } = this.options;
    const now = Date.now();
    db.setSetting(queueReceiptKey(key), JSON.stringify({ ...receipt, at: new Date(now).toISOString() }));
    db.raw.prepare(`DELETE FROM settings WHERE key LIKE 'outward-queue-receipt:%'
      AND json_valid(value) AND json_extract(value, '$.at') < ?`).run(new Date(now - QUEUE_RECEIPT_RETENTION_MS).toISOString());
  }

  /** Complete or requeue the claimed row from inside the lane owner, before the lane is released. */
  private settleDirect(key: string, runId: string): void {
    const { db } = this.options;
    const run = db.getRun(runId);
    if (!run || run.status === "running") return;
    db.runInTransaction(() => {
      this.writeQueueReceipt(key, { status: run.status, runId });
      db.setSetting(queueRunLinkKey(key), null);
    });
  }

  private async settleQueued(
    lane: ExecutionLaneHandle,
    session: OutwardAcpSessionRecord,
    queued: QueuedExecution,
    runId: string,
    capacityRequeue: boolean,
  ): Promise<void> {
    const { db } = this.options;
    if (capacityRequeue) {
      // A verified capacity rejection means the provider did not execute the
      // prompt, so retrying the same durable row is safe -- within a bound.
      const attemptsKey = `outward-queue-attempts:${queued.key}`;
      const attempts = Number(db.getSetting(attemptsKey) ?? "0") + 1;
      if (attempts < QUEUE_CAPACITY_RETRIES) {
        db.runInTransaction(() => {
          db.setSetting(attemptsKey, String(attempts));
          db.setSetting(queueRunLinkKey(queued.key), null);
          db.releasePendingClaim(lane, queued.id);
        });
        queued.requeued = true;
        return;
      }
    }
    const run = db.getRun(runId);
    if (!run || run.status === "running") return; // link stays: the next claim fails closed
    db.runInTransaction(() => {
      if (!db.completePendingMsg(lane, queued.id)) throw new Error("queued row claim was lost before settlement");
      this.writeQueueReceipt(queued.key, { status: run.status, runId });
      db.setSetting(queueRunLinkKey(queued.key), null);
      db.setSetting(`outward-queue-attempts:${queued.key}`, null);
    });
    if (queued.retainedId) await releaseRetainedOutwardAcpAttachments(session.cwd, queued.retainedId);
  }

  private scheduleDrain(session: OutwardAcpSessionRecord): void {
    if (this.closing || this.options.db.pendingMsgCount(OUTWARD_ACP_SURFACE, session.conversationId) === 0) return;
    setImmediate(() => {
      void this.drainQueued(session).catch((error) => console.error("[acp:outward] queue drain failed", error));
    });
  }

  /**
   * Run accepted messages in order while this process can own the lane. Any
   * ACP process or the supervised workspace owner may call this; the lane
   * lock and per-row claim make exactly one of them execute each message.
   */
  async drainQueued(session: OutwardAcpSessionRecord): Promise<void> {
    const { db } = this.options;
    const conversationId = session.conversationId;
    if (this.draining.has(conversationId)) return;
    this.draining.add(conversationId);
    try {
      while (!this.closing) {
        if (hasPendingCapacityWait(db, OUTWARD_ACP_SURFACE, conversationId)) return;
        const lane = db.acquireLock(OUTWARD_ACP_SURFACE, conversationId, false);
        if (!lane) return;
        let release = true;
        try {
          if (this.hasRunningRun(conversationId)) return;
          const row = db.claimNextPendingMsg(lane);
          if (!row) { if (!db.unlockIfQueueEmpty(lane)) continue; release = false; return; }
          const key = row.scheduledOccurrenceKey;
          const marker = row.attachments.find((entry) => entry.startsWith(RETAINED_ATTACHMENT_MARKER));
          const retainedId = marker ? marker.slice(RETAINED_ATTACHMENT_MARKER.length) : null;
          if (!key) { db.completePendingMsg(lane, row.id); continue; }
          const fail = async (reason: string, linkedRunId?: string): Promise<void> => {
            db.runInTransaction(() => {
              db.completePendingMsg(lane, row.id);
              this.writeQueueReceipt(key, { status: "failed", reason, ...(linkedRunId ? { runId: linkedRunId } : {}) });
              db.setSetting(queueRunLinkKey(key), null);
            });
            if (retainedId) await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
          };
          const priorRun = db.getSetting(queueRunLinkKey(key));
          if (priorRun) { await fail("interrupted", priorRun); continue; } // never replay an uncertain prompt
          let attachments: string[] = [];
          if (retainedId) {
            try { attachments = await readRetainedOutwardAcpAttachments(session.cwd, retainedId); }
            catch { await fail("attachments_unavailable"); continue; }
          }
          release = false;
          await this.runOnLane({
            session, prompt: row.prompt, attachments,
            signal: new AbortController().signal,
            onUpdate: () => undefined,
          }, lane, { id: row.id, key, retainedId, requeued: false });
          // runOnLane released the lane and scheduled the next drain.
          return;
        } finally {
          if (release && db.ownsLock(lane)) db.unlock(lane);
        }
      }
    } finally {
      this.draining.delete(conversationId);
    }
  }

  /** Supervised-owner entry: give every Workstream with accepted work a chance to run. */
  async drainAllQueued(): Promise<void> {
    const { db, lookupSession } = this.options;
    if (!lookupSession) return;
    const rows = db.raw.prepare("SELECT DISTINCT chat_id AS chatId FROM pending_messages WHERE surface = ?")
      .all(OUTWARD_ACP_SURFACE) as Array<{ chatId: string }>;
    for (const { chatId } of rows) {
      const session = lookupSession(String(chatId));
      if (session) await this.drainQueued(session);
    }
  }

  // ── Cross-process Stop ──────────────────────────────────────────────────

  /**
   * Stop a Run owned by another ACP process: record a durable request for that
   * exact Run, which its owner observes and contains. Locks are never released
   * here; a dead owner is handled by the existing proven-containment recovery.
   */
  private async requestRemoteStop(session: OutwardAcpSessionRecord): Promise<void> {
    const { db } = this.options;
    const running = db.listRunningRuns(OUTWARD_ACP_SURFACE).filter((run) => run.chat_id === session.conversationId);
    if (running.length === 0) return;
    for (const run of running) db.setSetting(remoteStopKey(run.run_id), new Date().toISOString());
    // Requests for Runs whose owner died never get consumed; bound their lifetime.
    db.raw.prepare("DELETE FROM settings WHERE key LIKE 'outward-cancel:%' AND value < ?")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const deadline = Date.now() + REMOTE_STOP_WAIT_MS;
    while (Date.now() < deadline) {
      if (running.every((run) => db.getRun(run.run_id)?.status !== "running")) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function requestKey(session: OutwardAcpSessionRecord, requestId: string): string {
  return `acp-request:${session.sessionId}:${requestId}`;
}
function remoteStopKey(runId: string): string { return `outward-cancel:${runId}`; }
function queueRunLinkKey(key: string): string { return `outward-queue-run:${key}`; }
function queueReceiptKey(key: string): string { return `outward-queue-receipt:${key}`; }
function queueReservationKey(key: string): string { return `outward-queue-reservation:${key}`; }

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
  if (env.INTERACTIVE_CLI_CHAIN?.split(",").some((kind) => kind.trim() === "custom-acp")) {
    throw new Error("outward ACP does not support custom-acp in the configured provider chain");
  }
  const fallback = (["codex", "claude", "antigravity", "grok", "cursor"] as BotKind[])
    .filter((kind) => allowed.includes(kind));
  const chain = parseCliChain(env.INTERACTIVE_CLI_CHAIN, { allowed, fallback });
  if (chain.length === 0) throw new Error("no interactive provider is configured for outward ACP");
  return chain;
}

/** Settings view for outward ACP commands (/models reads provider bot config). */
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
  lookupSession?: (sessionId: string) => OutwardAcpSessionRecord | null,
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
    getAvailableProviders: () => getCachedAvailableCliKinds({ env }) as ReadonlySet<BotKind>,
    isProviderAvailable: (provider) => getCachedAvailableCliKinds({ env }).has(provider as CliKind),
    enableDeferredCapacity: env.BRIDGE_OUTWARD_DEFERRED_CAPACITY_ENABLED === "1",
    lookupSession,
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
