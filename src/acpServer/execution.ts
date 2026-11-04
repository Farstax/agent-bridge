import * as acp from "@agentclientprotocol/sdk/unstable";
import { randomUUID } from "node:crypto";
import { abortCliProcessAndWait, toUserMessage } from "../cli.js";
import { loadBotsConfig, resolveExecutionCapacityConfig, resolveExecutionMode } from "../config.js";
import { openExecutionCapacityCoordinator } from "../executionCapacity.js";
import type { BridgeDb, DiscardedPendingMessage } from "../db.js";
import type { ExecutionLaneHandle } from "../db.js";
import { BridgeEngine, MAX_QUEUE_DEPTH, type PendingMessage, type SurfaceNeutralTurnInput } from "../engine.js";
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
import { QUEUED_ATTACHMENT_MARKER, readRetainedOutwardAcpAttachments, retainOutwardAcpAttachmentsForWait, releaseRetainedOutwardAcpAttachments } from "./attachments.js";
import { resolveLaneBusyMessageMode } from "../busyMessageMode.js";
import { discardDeskRunArtifacts, retainDeskArtifacts } from "./artifacts.js";
import { hasPendingCapacityWait, listRunContinuations, linkCapacityContinuationRun, requestRunContinuation, cancelPendingRunContinuation, settleRunContinuation, type RunContinuation } from "../runContinuation.js";


import { OUTWARD_ACP_SURFACE, outwardServiceId, recoverOutwardLanes } from "./recovery.js";
export { OUTWARD_ACP_SURFACE } from "./recovery.js";
const OUTWARD_ACP_EXECUTION_ERROR = -32001;
const OUTWARD_ACP_BUSY_ERROR = -32002;
const CANCELLATION_SWEEP_MS = 10;
const REMOTE_STOP_POLL_MS = 200;
const REMOTE_STOP_WAIT_MS = 5_000;
const QUEUE_CAPACITY_RETRIES = 5;
const QUEUE_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETAINED_ATTACHMENT_MARKER = QUEUED_ATTACHMENT_MARKER;

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
  laneHandle: ExecutionLaneHandle;
  key: string;
  retainedId: string | null;
  requeued: boolean;
  settled?: boolean;
  coreManaged?: boolean;
  coreOutcome?: "committed" | "deferred" | "settled";
};

/**
 * `confirmed`: no Run of the Workstream is running (it was cancelled by this
 * request or had already ended), proven from the durable Run record.
 * `pending`: Stop was requested but the owning process has not reported the
 * Run as ended. This is never success; the Run may still be executing.
 */
export type OutwardStopResult = "confirmed" | "pending";

export interface OutwardAcpPromptExecutor {
  execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse>;
  /** Standard ACP request cancellation: cancel the active request without clearing accepted queued work. */
  cancelActive(session: OutwardAcpSessionRecord): Promise<OutwardStopResult>;
  /** User-facing Bridge Stop: cancel the active Run and all accepted queued work. */
  cancel(session: OutwardAcpSessionRecord): Promise<OutwardStopResult>;
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

export type OutwardAcpExecutionEngine = Pick<BridgeEngine, "executeSurfaceNeutralTurn" | "recoverPendingQueue">;

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
  /** Bridge Core owns queue retirement; ACP supplies only its fence and receipt updates. */
  discardPendingMessages?: (
    session: OutwardAcpSessionRecord,
    beforeDiscard: () => void,
    afterDiscard: (pending: DiscardedPendingMessage[]) => void,
  ) => DiscardedPendingMessage[];
  /** How long a cross-process Stop waits for the owner to report the Run ended (test override). */
  remoteStopWaitMs?: number;
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

  /** Cancel a durable capacity wait under its execution-lane fence.
   * A claimed wait without an active lane has not crossed the provider boundary
   * and is still safely cancellable. ACP v1 `session/cancel` is request-scoped
   * and leaves accepted queued work intact; user-facing Stop owns queue cancellation.
   */
  async cancelDeferred(session: OutwardAcpSessionRecord): Promise<OutwardWorkstreamStatus> {
    const { db } = this.options;
    const wait = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) =>
      item.capacityWait === true && item.chatKey === session.conversationId && item.outward?.sessionId === session.sessionId
      && (item.state === "pending" || item.state === "claimed"));
    if (!wait) throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "no pending deferred Workstream task");
    const lane = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId);
    if (!lane) throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "deferred Workstream is busy");
    try {
      const settled = db.runWithLockFence(lane, () => db.runInTransaction(() => {
        // Read the same durable row under the transaction that changes it;
        // the worker's compare-and-swap claim may have won before this point.
        const current = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((item) => item.id === wait.id);
        if (!current || (current.state !== "pending" && current.state !== "claimed")) return false;
        if (current.successorRunId) {
          const successor = db.getRun(current.successorRunId);
          if (!successor || successor.status === "running" || successor.surface_identity !== OUTWARD_ACP_SURFACE
              || successor.chat_id !== current.chatKey) return false;
          if (successor.status === "done") {
            settleRunContinuation(db, wait.id, "completed");
            if (current.outward?.receiptKey) {
              this.writeQueueReceipt(current.outward.receiptKey, {
                outcome: "settled", status: "done", runId: successor.run_id, continuationId: wait.id,
              });
            }
            return listRunContinuations(db, OUTWARD_ACP_SURFACE).some((item) => item.id === wait.id && item.state === "completed");
          }
        }
        const cancelled = cancelPendingRunContinuation(db, wait.id, "cancelled_by_owner");
        if (cancelled && current.outward?.receiptKey) {
          this.writeQueueReceipt(current.outward.receiptKey, { outcome: "settled", status: "cancelled", reason: "stopped", continuationId: wait.id });
        }
        return cancelled;
      }));
      if (!settled) {
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

  /**
   * User-initiated Stop: discard all accepted-but-unstarted work for the
   * Workstream, then cancel the active Run. Interrupt mode, request aborts and
   * shutdown use `cancelRun` instead, which never touches the queue.
   */
  async cancel(session: OutwardAcpSessionRecord): Promise<OutwardStopResult> {
    const { db } = this.options;
    const beforeDiscard = () => {
      // Fence admission in the same transaction as queue removal. A prompt
      // racing Stop is either admitted first and removed here, or observes the
      // fence and is rejected; it cannot slip into the queue after Stop.
      db.setSetting(stopFenceKey(session.conversationId), new Date().toISOString());
    };
    const afterDiscard = (rows: DiscardedPendingMessage[]) => {
      for (const row of rows) {
        if (!row.scheduledOccurrenceKey) continue;
        // A retried client request must see "cancelled", never re-admit the work.
        this.writeQueueReceipt(row.scheduledOccurrenceKey, { status: "cancelled", reason: "stopped" });
        clearSetting(db, queueRunLinkKey(row.scheduledOccurrenceKey));
        clearSetting(db, queueReservationKey(row.scheduledOccurrenceKey));
        clearSetting(db, `outward-queue-attempts:${row.scheduledOccurrenceKey}`);
      }
    };
    const discarded = this.options.discardPendingMessages
      ? this.options.discardPendingMessages(session, beforeDiscard, afterDiscard)
      : db.runInImmediateTransaction(() => {
        beforeDiscard();
        const rows = db.discardPendingMsgs(OUTWARD_ACP_SURFACE, session.conversationId);
        afterDiscard(rows);
        return rows;
      });
    const retainedOf = (row: (typeof discarded)[number]): string | null => {
      const marker = row.attachments.find((entry) => entry.startsWith(RETAINED_ATTACHMENT_MARKER));
      return marker ? marker.slice(RETAINED_ATTACHMENT_MARKER.length) : null;
    };
    // Unstarted rows have no reader; release their private snapshots now.
    for (const row of discarded.filter((candidate) => candidate.state === "queued")) {
      const id = retainedOf(row);
      if (id) await releaseRetainedOutwardAcpAttachments(session.cwd, id).catch(() => undefined);
    }
    const run = await this.cancelRun(session);
    const waitPending = await this.cancelCapacityWait(session, run === "confirmed");
    const laneSettled = run === "confirmed" && !waitPending
      ? await this.waitForLaneSettlement(session)
      : false;
    if (run === "confirmed") {
      // The claimed row's Run has ended, so its snapshot has no reader left.
      for (const row of discarded.filter((candidate) => candidate.state === "claimed")) {
        const id = retainedOf(row);
        if (id) await releaseRetainedOutwardAcpAttachments(session.cwd, id).catch(() => undefined);
      }
    }
    if (run === "confirmed" && !waitPending && laneSettled && this.clearSettledStopFence(session)) return "confirmed";
    return "pending";
  }

  private async waitForLaneSettlement(session: OutwardAcpSessionRecord): Promise<boolean> {
    const deadline = Date.now() + (this.options.remoteStopWaitMs ?? REMOTE_STOP_WAIT_MS);
    while (this.options.db.hasExecutionLaneLock(OUTWARD_ACP_SURFACE, session.conversationId)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }

  async cancelActive(session: OutwardAcpSessionRecord): Promise<OutwardStopResult> {
    return this.cancelRun(session);
  }

  /** Clear Stop admission fencing only after no Run, lock, queue or capacity wait can still execute. */
  private clearSettledStopFence(session: OutwardAcpSessionRecord): boolean {
    return clearSettledStopFence(this.options.db, session.conversationId);
  }

  /** Recovery owner calls this after fenced Run/lock reconciliation. */
  reconcileStopFences(): void {
    const prefix = "outward-stop-fence:";
    const rows = this.options.db.raw.prepare("SELECT key FROM settings WHERE key LIKE ? ORDER BY key")
      .all(`${prefix}%`) as Array<{ key: string }>;
    for (const { key } of rows) clearSettledStopFence(this.options.db, key.slice(prefix.length));
  }

  /** Cancel a capacity wait once any claimed successor Run has durably settled. */
  private async cancelCapacityWait(session: OutwardAcpSessionRecord, runSettled: boolean): Promise<boolean> {
    const wait = listRunContinuations(this.options.db, OUTWARD_ACP_SURFACE).find((item) =>
      item.capacityWait === true && item.chatKey === session.conversationId && item.outward?.sessionId === session.sessionId
      && (item.state === "pending" || item.state === "claimed"));
    if (!wait) return false;
    if (wait.state === "claimed" && !runSettled) return true;
    try { await this.cancelDeferred(session); } catch { /* re-read durable state below */ }
    return hasPendingCapacityWait(this.options.db, OUTWARD_ACP_SURFACE, session.conversationId);
  }

  /** Cancel only the active Run, wherever its owner process is; the queue is untouched. */
  private async cancelRun(session: OutwardAcpSessionRecord): Promise<OutwardStopResult> {
    const record = this.active.get(session.conversationId);
    if (!record) return this.requestRemoteStop(session);
    record.cancelRequested = true;
    if (record.cancelPromise) { await record.cancelPromise; return "confirmed"; }

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
    // The loop above only ends once the owning outer Run has settled.
    return "confirmed";
  }

  /** Cancel all active requests and wait until their outer Run persistence settles. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const records = [...this.active.values()];
    await Promise.all(records.map(async (record) => {
      await this.cancelRun(record.session);
      await record.done;
    }));
  }

  async execute(input: OutwardAcpPromptExecutionInput): Promise<acp.PromptResponse> {
    const { db } = this.options;
    // Only a client that opted into the advertised busy-message extension may
    // submit during an active Run; every other client keeps ACP v1 fail-fast.
    const optedIn = input.busyMessages === true && !input.capacityResume;
    const conversationId = input.session.conversationId;
    if (optedIn && input.requestId) {
      const replay = this.replayRequest(input.session, input.requestId);
      if (replay) return replay;
    }
    if (db.getSetting(stopFenceKey(conversationId))) {
      // A Stop caller may have disconnected while cancellation was pending.
      // Retry the existing proof-based recovery before keeping the lane fenced.
      await recoverOutwardLanes(db);
      this.reconcileStopFences();
    }
    if (db.getSetting(stopFenceKey(conversationId))) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Stop is still pending", { sessionId: input.session.sessionId });
    }
    if (hasPendingCapacityWait(db, OUTWARD_ACP_SURFACE, input.session.conversationId, input.capacityResume?.id)) {
      throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Workstream is awaiting provider capacity");
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
        clearSetting(db, reservationKey);
      }
    }
  }

  /** Answer a repeated client request from durable state; never admit it twice. */
  private replayRequest(session: OutwardAcpSessionRecord, requestId: string): acp.PromptResponse | null {
    const { db } = this.options;
    const key = requestKey(session, requestId);
    const settled = db.getSetting(queueReceiptKey(key));
    if (settled) return this.storedQueueReceipt(settled, requestId);
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
    clearSetting(db, queueRunLinkKey(key));
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
        // A Stop that discarded this claimed row won: no Run may be created for it.
        if (queued && !db.ownsPendingClaim(lane, queued.id)) throw new QueuedMessageStopped();
        if (db.getSetting(stopFenceKey(input.session.conversationId))) {
          if (queued) throw new QueuedMessageStopped();
          throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Stop is still pending", { sessionId: input.session.sessionId });
        }
        db.insertRun(runId, identity, provider);
        // Persist the Run -> queued row link with the Run, so a crash after this
        // point can never replay a prompt whose execution may have started.
        if (idempotencyKey) {
          db.setSetting(queueRunLinkKey(idempotencyKey), runId);
          if (reservationToken) clearSetting(db, queueReservationKey(idempotencyKey));
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
        void this.cancelRun(input.session).catch(() => {
          console.warn("[acp:outward] cancellation cleanup failed");
        });
      };
      if (!input.signal.aborted) input.signal.addEventListener("abort", signalAbort, { once: true });
      // A Stop from another ACP process cannot reach this process's memory; it
      // leaves a durable request keyed by this exact Run, observed here.
      stopPoll = setInterval(() => {
        try {
          if (db.getSetting(remoteStopKey(runId))) {
            void this.cancelRun(input.session).catch(() => console.warn("[acp:outward] remote stop cleanup failed"));
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
        await discardDeskRunArtifacts(input.session.conversationId, runId).catch(() => {
          console.warn("[acp:outward] could not reclaim cancelled Desk artifacts");
        });
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
      await discardDeskRunArtifacts(input.session.conversationId, runId).catch(() => {
        console.warn("[acp:outward] could not reclaim failed Desk artifacts");
      });
      if (error instanceof QueuedMessageStopped) return { stopReason: "cancelled" };
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
          const persistWait = () => requestRunContinuation(db, {
            continuationId,
            originRunId: runId,
            surfaceIdentity: OUTWARD_ACP_SURFACE,
            chatKey: input.session.conversationId,
            provider: activeProvider,
            reason: "configured providers at capacity or requiring authentication",
            afterSeconds: 300,
            capacityWait: true,
            outward: {
              sessionId: input.session.sessionId,
              prompt: input.prompt,
              attachmentCount: input.attachments?.length ?? 0,
              ...(queued?.key ? { receiptKey: queued.key } : input.requestId ? { receiptKey: requestKey(input.session, input.requestId) } : {}),
            },
          });
          if (queued) {
            // Commit the existing capacity wait and queue-row retirement together.
            // Recovery can then never run both records for the same accepted turn.
            db.runInTransaction(() => {
              persistWait();
              if (!db.completePendingMsg(active!.lane, queued.id)) {
                throw new Error("queued row claim was lost before capacity handoff");
              }
              this.writeQueueReceipt(queued.key, { outcome: "deferred", status: "waiting", runId, continuationId });
              clearSetting(db, queueRunLinkKey(queued.key));
              clearSetting(db, `outward-queue-attempts:${queued.key}`);
              queued.settled = true;
            });
          } else {
            persistWait();
          }
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
        try { clearSetting(db, remoteStopKey(runId)); } catch { /* expiry sweep removes it */ }
      }
      if (active && this.active.get(input.session.conversationId) === active) {
        this.active.delete(input.session.conversationId);
      }
      try {
        // Settle the durable queue row while this process still owns the lane.
        if (queued?.coreManaged) {
          queued.coreOutcome = await this.settleQueuedThroughCore(input.session, queued, runId, queueCapacityRequeue);
          if ((queued.coreOutcome === "committed" || queued.settled) && queued.retainedId) {
            await releaseRetainedOutwardAcpAttachments(input.session.cwd, queued.retainedId).catch(() => undefined);
          }
        } else if (queued?.settled) {
          if (queued.retainedId) await releaseRetainedOutwardAcpAttachments(input.session.cwd, queued.retainedId);
        } else if (queued) await this.settleQueued(lane, input.session, queued, runId, queueCapacityRequeue);
        else if (idempotencyKey) this.settleDirect(idempotencyKey, runId);
      } catch (error) {
        console.error("[acp:outward] queued message settlement failed", error);
      }
      if (!queued?.coreManaged) {
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
      } else {
        if (active) {
          active.settled = true;
          active.finishDone();
        }
      }
    }
  }

  /** BridgeEngine owns the queue claim and retirement; ACP only settles its receipt. */
  private async settleQueuedThroughCore(
    session: OutwardAcpSessionRecord,
    queued: QueuedExecution,
    runId: string,
    capacityRequeue: boolean,
  ): Promise<"committed" | "deferred" | "settled"> {
    const { db } = this.options;
    if (queued.settled) return "settled"; // capacity continuation handoff retired it atomically
    if (capacityRequeue) {
      const attemptsKey = `outward-queue-attempts:${queued.key}`;
      const attempts = Number(db.getSetting(attemptsKey) ?? "0") + 1;
      const settled = db.runInImmediateTransaction(() => {
        if (!db.ownsPendingClaim(queued.laneHandle, queued.id)) return false;
        db.setSetting(attemptsKey, String(attempts));
        clearSetting(db, queueRunLinkKey(queued.key));
        if (attempts < QUEUE_CAPACITY_RETRIES) {
          this.writeQueueReceipt(queued.key, { outcome: "queued", status: "queued", reason: "provider_capacity" });
        } else {
          this.writeQueueReceipt(queued.key, { outcome: "settled", status: "failed", reason: "provider_capacity" });
          clearSetting(db, attemptsKey);
        }
        return true;
      });
      if (!settled) return "settled"; // Stop or recovery retired this claim; preserve its receipt.
      return attempts < QUEUE_CAPACITY_RETRIES ? "deferred" : "committed";
    }
    const run = db.getRun(runId);
    if (!run || run.status === "running") return "settled"; // preserve the run link and claimed row; never replay uncertain work
    const settled = db.runInImmediateTransaction(() => {
      if (!db.ownsPendingClaim(queued.laneHandle, queued.id)) return false;
      this.writeQueueReceipt(queued.key, { status: run.status, runId });
      clearSetting(db, queueRunLinkKey(queued.key));
      clearSetting(db, `outward-queue-attempts:${queued.key}`);
      return true;
    });
    return settled ? "committed" : "settled"; // Stop retired the claim and owns its receipt.
  }

  /** Execute a claimed durable message; BridgeEngine owns its lane and queue lifecycle. */
  async executeQueuedMessage(session: OutwardAcpSessionRecord, message: PendingMessage): Promise<"committed" | "deferred" | "settled"> {
    const key = message.scheduledOccurrenceKey;
    if (!key || !message.laneHandle) return "committed";
    const existingReceipt = this.options.db.getSetting(queueReceiptKey(key));
    if (existingReceipt) {
      try {
        const receipt = JSON.parse(existingReceipt) as { status?: unknown };
        if (["done", "failed", "cancelled", "steered"].includes(String(receipt.status))) return "committed";
      } catch { /* corrupt receipts fail closed through the Run link below */ }
    }
    const linkedRun = this.options.db.getSetting(queueRunLinkKey(key));
    if (linkedRun) {
      const run = this.options.db.getRun(linkedRun);
      if (run?.status === "running") return "settled";
      this.writeQueueReceipt(key, { status: "failed", reason: "interrupted", runId: linkedRun });
      clearSetting(this.options.db, queueRunLinkKey(key));
      return "committed";
    }
    const marker = message.attachments.find((entry) => entry.startsWith(RETAINED_ATTACHMENT_MARKER));
    const retainedId = marker ? marker.slice(RETAINED_ATTACHMENT_MARKER.length) : null;
    let attachments: string[] = [];
    if (retainedId) {
      try { attachments = await readRetainedOutwardAcpAttachments(session.cwd, retainedId); }
      catch {
        this.writeQueueReceipt(key, { status: "failed", reason: "attachments_unavailable" });
        await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
        return "committed";
      }
    }
    const queued: QueuedExecution = { id: message.id, laneHandle: message.laneHandle!, key, retainedId, requeued: false, coreManaged: true };
    try {
      await this.runOnLane({
        session,
        prompt: message.prompt,
        attachments,
        signal: new AbortController().signal,
        onUpdate: () => undefined,
        deferCapacity: this.supportsDeferredCapacity,
        busyMessages: true,
      }, message.laneHandle, queued);
    } catch (error) {
      if (!queued.coreOutcome) throw error;
    }
    return queued.coreOutcome ?? "settled";
  }

  // ── Busy-message admission (#1130) ──────────────────────────────────────

  private busyMode(session: OutwardAcpSessionRecord) {
    return resolveLaneBusyMessageMode(this.options.db, OUTWARD_ACP_SURFACE, session.conversationId, "queue");
  }

  private queueReceipt(
    outcome: "queued" | "steered" | "settled" | "running" | "deferred",
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
    if (settled) return this.storedQueueReceipt(settled, input.requestId);
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
      }, MAX_QUEUE_DEPTH, queueReceiptKey(key), queueRunLinkKey(key), queueReservationKey(key), reservationToken ?? "", stopFenceKey(session.conversationId));
    } catch (error) {
      await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
      throw error;
    }
    if (admission.kind !== "queued") {
      await releaseRetainedOutwardAcpAttachments(session.cwd, retainedId).catch(() => undefined);
      if (admission.kind === "full") {
        throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP queue is full", { sessionId: session.sessionId });
      }
      if (admission.kind === "blocked") {
        throw new acp.RequestError(OUTWARD_ACP_BUSY_ERROR, "outward ACP Stop is still pending", { sessionId: session.sessionId });
      }
      if (admission.kind === "existing") {
        return this.queueReceipt("queued", {
          queueId: admission.id, mode, position: admission.position, requestId: input.requestId,
        });
      }
      if (admission.kind === "running") {
        return this.queueReceipt("running", { runId: admission.runId, requestId: input.requestId });
      }
      return this.storedQueueReceipt(admission.value, input.requestId);
    }
    const queueId = admission.id;
    let steered = false;
    if (mode === "interrupt") await this.cancelRun(session);
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
      if (settled) return this.storedQueueReceipt(settled, input.requestId);
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

  private storedQueueReceipt(value: string, requestId?: string): acp.PromptResponse {
    const receipt = JSON.parse(value) as Record<string, unknown>;
    const outcome = receipt.outcome === "deferred" ? "deferred"
      : receipt.outcome === "queued" || receipt.status === "queued" ? "queued"
        : "settled";
    return this.queueReceipt(outcome, {
      ...(requestId ? { requestId } : {}), ...receipt,
    });
  }

  /** Complete or requeue the claimed row from inside the lane owner, before the lane is released. */
  private settleDirect(key: string, runId: string): void {
    const { db } = this.options;
    const run = db.getRun(runId);
    if (!run || run.status === "running") return;
    db.runInTransaction(() => {
      const capacityWait = listRunContinuations(db, OUTWARD_ACP_SURFACE).find((wait) =>
        wait.capacityWait === true && wait.originRunId === runId && (wait.state === "pending" || wait.state === "claimed"));
      if (capacityWait) {
        this.writeQueueReceipt(key, { outcome: "deferred", status: "waiting", runId, continuationId: capacityWait.id });
      } else {
        this.writeQueueReceipt(key, { status: run.status, runId });
      }
      clearSetting(db, queueRunLinkKey(key));
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
          clearSetting(db, queueRunLinkKey(queued.key));
          db.releasePendingClaim(lane, queued.id);
        });
        queued.requeued = true;
        return;
      }
    }
    const run = db.getRun(runId);
    if (!run || run.status === "running") return; // link stays: the next claim fails closed
    db.runInTransaction(() => {
      // A user Stop deletes the claimed row and writes the cancelled receipt itself.
      if (!db.completePendingMsg(lane, queued.id)) return;
      this.writeQueueReceipt(queued.key, { status: run.status, runId });
      clearSetting(db, queueRunLinkKey(queued.key));
      clearSetting(db, `outward-queue-attempts:${queued.key}`);
    });
    if (queued.retainedId) await releaseRetainedOutwardAcpAttachments(session.cwd, queued.retainedId);
  }

  private scheduleDrain(session: OutwardAcpSessionRecord): void {
    if (this.closing || this.options.db.pendingMsgCount(OUTWARD_ACP_SURFACE, session.conversationId) === 0) return;
    setImmediate(() => {
      void this.drainQueued(session).catch((error) => console.error("[acp:outward] shared queue recovery failed", error));
    });
  }

  /** BridgeEngine claims, executes, settles and fences the shared durable queue. */
  async drainQueued(session: OutwardAcpSessionRecord): Promise<void> {
    if (this.closing || !this.options.db.raw.open) return;
    await this.options.createEngine(session, this.selectedProvider(session))
      // A transient ACP client must not replace an expired lease while its
      // previous owner may still be executing an external provider process.
      .recoverPendingQueue(session.conversationId, undefined, undefined, false);
  }

  /** Supervised-owner entry: give every Workstream with accepted work a chance to run. */
  async drainAllQueued(): Promise<void> {
    const { db, lookupSession } = this.options;
    this.reconcileStopFences();
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
  private async requestRemoteStop(session: OutwardAcpSessionRecord): Promise<OutwardStopResult> {
    const { db } = this.options;
    const running = db.listRunningRuns(OUTWARD_ACP_SURFACE).filter((run) => run.chat_id === session.conversationId);
    if (running.length === 0) return "confirmed";
    for (const run of running) db.setSetting(remoteStopKey(run.run_id), new Date().toISOString());
    // Requests for Runs whose owner died never get consumed; bound their lifetime.
    db.raw.prepare("DELETE FROM settings WHERE key LIKE 'outward-cancel:%' AND (value IS NULL OR value < ?)")
      .run(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const deadline = Date.now() + (this.options.remoteStopWaitMs ?? REMOTE_STOP_WAIT_MS);
    while (Date.now() < deadline) {
      if (running.every((run) => db.getRun(run.run_id)?.status !== "running")) return "confirmed";
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // An unresponsive or vanished owner leaves the Run durably `running`. That
    // is unknown, not stopped: locks are not released and nothing is replayed;
    // only the owner or proven-containment recovery may end the Run.
    return "pending";
  }
}

/** A user Stop discarded the queued message before its Run was created. */
class QueuedMessageStopped extends Error {
  constructor() { super("queued message was stopped before execution"); this.name = "QueuedMessageStopped"; }
}

/** Delete a durable key. setSetting(key, null) would persist a NULL row per Run, forever. */
function clearSetting(db: BridgeDb, key: string): void {
  db.raw.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

function clearSettledStopFence(db: BridgeDb, conversationId: string): boolean {
  return db.runInImmediateTransaction(() => {
    const running = db.listRunningRuns(OUTWARD_ACP_SURFACE).some((run) => run.chat_id === conversationId);
    if (running || db.hasChatLock(conversationId)
        || db.pendingMsgCount(OUTWARD_ACP_SURFACE, conversationId) > 0
        || hasPendingCapacityWait(db, OUTWARD_ACP_SURFACE, conversationId)) return false;
    clearSetting(db, stopFenceKey(conversationId));
    return true;
  });
}

function stopFenceKey(conversationId: string): string { return `outward-stop-fence:${conversationId}`; }

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
  const capacity = resolveExecutionCapacityConfig(env);
  const executionCapacityDb = openExecutionCapacityCoordinator(capacity, dbPath, db, {
    serviceId: outwardServiceId(),
    installationId: env.AGENT_BRIDGE_INSTALLATION_ID,
    requireInstallationIdentity: env.NODE_ENV === "production" && Boolean(env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
    databaseRole: "interactive",
    // A separate coordinator connection is opened for every transient ACP client;
    // trusted rollout and long-lived service startup own full integrity scans.
    verifyForeignKeyIntegrity: false,
  });
  if (executionCapacityDb && executionCapacityDb !== db) {
    db.onClose(() => executionCapacityDb.close());
  }
  const allowedUserIds = new Set<string>();
  let outwardExecutor: BridgeOutwardAcpPromptExecutor | null = null;
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
      allowRunContinuations: false,
      maxConcurrentExecutions: capacity.maxConcurrentExecutions,
      executionCapacityDb: executionCapacityDb ?? undefined,
      hooks: {
        onQueuedMessage: (message) => {
          if (!outwardExecutor) throw new Error("outward ACP queue owner is not ready");
          return outwardExecutor.executeQueuedMessage(session, message);
        },
      },
    }, db, NO_DELIVERY_PLATFORM);
  };
  outwardExecutor = new BridgeOutwardAcpPromptExecutor({
    db,
    providerChain,
    getAvailableProviders: () => getCachedAvailableCliKinds({ env }) as ReadonlySet<BotKind>,
    isProviderAvailable: (provider) => getCachedAvailableCliKinds({ env }).has(provider as CliKind),
    enableDeferredCapacity: env.BRIDGE_OUTWARD_DEFERRED_CAPACITY_ENABLED === "1",
    lookupSession,
    discardPendingMessages: (session, beforeDiscard, afterDiscard) =>
      buildEngine(session, providerChain[0]).discardPendingMessages(session.conversationId, beforeDiscard, afterDiscard),
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
          onOutputArtifacts: (outDir) => {
            const count = db.raw.prepare(
              "SELECT COUNT(*) AS count FROM conversation_turns WHERE chat_key = ? AND surface_identity = ? AND role = 'user'",
            ).get(session.conversationId, OUTWARD_ACP_SURFACE) as { count: number } | undefined;
            return retainDeskArtifacts(outDir, session.conversationId, turnInput.runId, Math.max(0, (count?.count ?? 1) - 1));
          },
        }),
        recoverPendingQueue: (chatKey, activeContinuationId, capacityClaimToken) =>
          engine.recoverPendingQueue(chatKey, activeContinuationId, capacityClaimToken, false),
      };
    },
  });
  return outwardExecutor;
}
