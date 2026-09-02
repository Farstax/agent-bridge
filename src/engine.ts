/**
 * PURPOSE: Reusable BridgeEngine — polling loop, concurrency locking, message queuing,
 *   and CLI execution dispatcher. Extracted from BridgeBot (index.ts) so both the agent
 *   bots and the health bot can share one robust implementation.
 * INPUTS: Engine options (kind, botConfig, allowedUserIds, hooks), BridgeDb, TelegramClient.
 * OUTPUTS: Telegram replies, CLI dispatches, session/lock state updates.
 * NEIGHBORS: src/index.ts, src/index-health.ts, src/cli.ts, src/db.ts, src/telegram.ts
 */

import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import {
  buildCliInvocation,
  buildExecutionOptions,
  runCli as _runCli,
  runCliAsync as _runCliAsync,
  parseCliResult,
  isCapacityExhaustedError,
  getNextFallbackModel,
  abortCliProcess,
  abortExecutionAndWait,
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  toUserMessage,
  scrubOutputDir,
  CliTimeoutError,
} from "./cli.js";
import { resolveAntigravityConversationId, setAntigravityModel } from "./providers/antigravityRuntime.js";
import { supportsToolFreeMode } from "./providers/registry.js";
import { surfaceCapabilities, type MessagingPlatform } from "./platform.js";
import { adaptTelegramMessage, adaptTelegramUpdate, InteractiveTurnBuffer, type InteractiveTurnInput } from "./interactiveIngress.js";
import { downloadSurfaceAttachment } from "./fileDownload.js";
import { prepareOutputDir, uploadOutputFiles } from "./fileOutput.js";
import { parseClaudeStreamJsonOutput } from "./claudeStreamJson.js";
import { createClaudeAnswerPresentationDecoder } from "./providers/claudeAnswerPresentation.js";
import { createAntigravityAnswerPresentationDecoder } from "./providers/antigravityAnswerPresentation.js";
import { createPollErrorState, planPollError, notePollSuccess } from "./polling.js";
import { sendSurfaceMessage, sendMessageWithProgress, PreviewCleanupError } from "./messageDelivery.js";
import { buildModelKeyboard, buildModelsText, getCliWorkingDir } from "./bridge.js";
import { handleCommand, buildTelegramCommands, isAntigravityNarrationVisible } from "./commands.js";
import { buildBusyMessageModeKeyboard, busyMessageModeSettingKey, resolveLaneBusyMessageMode, type BusyMessageMode } from "./busyMessageMode.js";
import { buildEffortKeyboard, buildEffortText, effortSettingKey, resolveDefaultEffort, resolveEffort, isEffortLevel } from "./effort.js";
import { getCodexUsageText } from "./codexUsage.js";
import { clearHandoffRequired, isProviderFallbackHandoffRequired } from "./handoffState.js";
import { deriveConversationOwnerKey } from "./conversationOwnerKey.js";
import { prependWorkspaceContext } from "./workspaceContext.js";
import type { BridgeEvent } from "./events/types.js";
import { EventStore } from "./events/store.js";
import type { BridgeConfig, BotKind, TelegramUpdate, TelegramMessage, TelegramCallbackQuery, CliResult, CliOptions } from "./types.js";
import { ExecutionLockLostError, type BridgeDb, type ExecutionLaneHandle } from "./db.js";
import { DEFAULT_CONTEXT_MAX_CHARS } from "./db.js";
import { linkScheduledOccurrenceRun } from "./scheduledRunCorrelation.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { prependHandoffModel, prependProviderFallbackContinuation } from "./promptWrapping.js";
import type { AdvisorCapabilityIssuer } from "./advisorBroker.js";
import {
  executionLaneCoordinator,
  type ExecutionLaneCoordinator,
  type LaneCancellation,
  type AugmentedTask,
  type LaneDrainer,
  type FinalDeliveryPhase,
} from "./executionLaneCoordinator.js";

export interface HookContext {
  chatId: number | string;
  chatKey: string;
  threadId?: number | string;
  userId?: number | string;
}

export interface HookCommandResult {
  text: string;
  reply_markup?: any;
}

export interface BridgeEngineHooks {
  onCommand?: (cmd: string, ctx: HookContext) => Promise<HookCommandResult | null>;
  onBeforeExecute?: (prompt: string, ctx: HookContext) => Promise<string>;
  onCapacityExhausted?: (chatKey: string) => void | Promise<void>;
  onAfterExecute?: (prompt: string, resultText: string, ctx: HookContext) => void | Promise<void>;
  onQueuedMessage?: (message: PendingMessage) => Promise<ExecutionOutcome>;
}

export interface PendingMessage {
  id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;
  scheduledOccurrenceKeys?: string[];
  pendingIds?: number[];
  queueRecoveryAttempt?: number;
  laneHandle?: ExecutionLaneHandle;
  laneLifecycleManaged?: boolean;
}

export type ExecutionOutcome = "committed" | "queued" | "failed" | "fenced";

type StagedCliResult = CliResult & {
  nativeSessionMode?: "fresh" | "resume";
};

const MAX_QUEUE_RECOVERY_ATTEMPTS = 3;

class LostExecutionLeaseError extends Error {
  constructor() { super("execution lane ownership lost"); }
}

export interface BridgeEngineOptions {
  kind: string;
  surfaceIdentity: string;
  executionKind?: BotKind;
  botConfig: { command: string; modelPreference: string[]; token?: string };
  allowedUserIds: ReadonlySet<string>;
  executionMode: "safe" | "trusted";
  busyMessageMode?: "augment" | "interrupt" | "queue";
  pollIntervalMs: number;
  soulContext?: string | null;
  workingDir?: string;
  workspaceContext?: string | null;
  fullConfig?: BridgeConfig;
  hooks?: BridgeEngineHooks;
  advisorCapabilities?: AdvisorCapabilityIssuer;
}

export interface ExecFns {
  runCli: typeof _runCli;
  runCliAsync: typeof _runCliAsync;
}

export interface SurfaceNeutralTurnInput {
  prompt: string;
  sessionId: string | null;
  chatId: number | string;
  chatKey: string;
  laneHandle: ExecutionLaneHandle;
  runId: string;
  eventContext: NonNullable<CliOptions["eventContext"]>;
  collect: (event: BridgeEvent) => void;
  onProviderExecutionStarted?: () => void;
}

const MAX_QUEUE_DEPTH = 5;
const ENGINE_CONTEXT_MAX_CHARS = parseInt(process.env.BRIDGE_CONTEXT_MAX_CHARS ?? "") || DEFAULT_CONTEXT_MAX_CHARS;
const ENGINE_TURN_TEXT_LIMIT = 1_200;
const AGENT_KINDS = new Set<string>(["codex", "antigravity", "claude", "grok", "cursor"]);
function isAgentKind(kind: string): kind is BotKind {
  return AGENT_KINDS.has(kind);
}

function isAntigravityPrintTimeoutError(error: Error): boolean {
  return /agy execution timed out waiting for response|print mode timed out waiting for response/i.test(error.message ?? "");
}

function isRecoverableAntigravityExecutionError(error: Error): boolean {
  const message = error.message ?? "";
  return /error executing cascade step:|agent executor error:|PlannerResponse without ModifiedResponse|Agy stalled in planner loop without usable output|Agy JSON parse failed/i.test(message);
}

function topicChatKey(chatId: number | string, chatType: string, threadId?: number | string): string {
  return threadId != null ? `${chatId}:${threadId}` : String(chatId);
}

function telegramUpdateChatKey(update: TelegramUpdate): string | null {
  const source = update.message ?? update.callback_query?.message;
  if (!source?.chat) return null;
  return topicChatKey(source.chat.id, source.chat.type ?? "private", source.message_thread_id);
}

function hookContext(chatId: number | string, chatKey: string, threadId?: number | string): HookContext {
  return { chatId, chatKey, threadId };
}

function trimTurnText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= ENGINE_TURN_TEXT_LIMIT) return normalized;
  return `${normalized.slice(0, ENGINE_TURN_TEXT_LIMIT - 15).trimEnd()}... [truncated]`;
}

export class BridgeEngine {
  readonly kind: string;
  readonly client: MessagingPlatform;
  readonly mediaBuffer: InteractiveTurnBuffer;

  private readonly opts: BridgeEngineOptions;
  private readonly surfaceIdentity: string;
  private readonly db: BridgeDb;
  private readonly hooks: BridgeEngineHooks;
  private readonly exec: ExecFns;
  private queuedMessageHandler?: (message: PendingMessage) => Promise<ExecutionOutcome>;
  private readonly queueRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly startupQueueRecoveryTimers = new Map<string, NodeJS.Timeout>();
  private readonly laneCoordinator: ExecutionLaneCoordinator;
  private readonly seenInteractiveMessageKeys = new Set<string>();

  constructor(
    opts: BridgeEngineOptions,
    db: BridgeDb,
    client: MessagingPlatform,
    exec: Partial<ExecFns> = {},
  ) {
    if (!opts.surfaceIdentity?.trim()) throw new Error("BridgeEngine surfaceIdentity is required");
    this.opts = opts;
    this.kind = opts.kind;
    this.surfaceIdentity = opts.surfaceIdentity;
    this.db = db;
    this.laneCoordinator = executionLaneCoordinator(db, this.surfaceIdentity);
    this.client = client;
    this.hooks = opts.hooks ?? {};
    this.queuedMessageHandler = this.hooks.onQueuedMessage;
    const runCliAsync = exec.runCliAsync ?? (exec.runCli
      ? async (command, args, cwd, options) => ({ text: await exec.runCli!(command, args, cwd, options) })
      : _runCliAsync);
    this.exec = {
      runCli: exec.runCli ?? _runCli,
      runCliAsync,
    };
    this.mediaBuffer = new InteractiveTurnBuffer((_groupId, turns) => {
      return this.handleInteractiveMessages(turns).catch((err) => {
        console.error(`[${this.kind}] mediaBuffer flush error`, err);
      });
    }, 1500);
  }

  private _workingDir(executionKind: BotKind = this._executionKind()): string {
    return this.opts.workingDir ?? getCliWorkingDir(executionKind);
  }

  async run(): Promise<void> {
    const capabilities = surfaceCapabilities(this.client);
    const getUpdates = this.client.getUpdates;
    if (!capabilities.polling || typeof getUpdates !== "function") {
      throw new Error(`[${this.kind}] polling is not supported by this messaging surface`);
    }
    if (isAgentKind(this.kind)) {
      await this.client.setMyCommands({
        commands: buildTelegramCommands(this.kind),
      }).catch((err) => console.warn(`[${this.kind}] setMyCommands failed`, err));
    }
    await this.recoverPendingQueues();

    let offset = isAgentKind(this.kind) ? this.db.getLastUpdateId(this.kind) + 1 : 0;
    console.log(`[${this.kind}] engine online (offset: ${offset})`);

    const pollErrState = createPollErrorState();
    const defaultErrorSleepMs = Math.max(this.opts.pollIntervalMs, 5000);

    for (;;) {
      try {
        const updates = await getUpdates.call(this.client, {
          offset,
          timeout: 30,
          allowed_updates: ["message", "callback_query"],
        });

        if (notePollSuccess(pollErrState)) {
          console.log(`[${this.kind}] polling recovered`);
        }

        for (const update of (updates.result as any) ?? []) {
          const updateId: number = update.update_id;
          offset = updateId + 1;
          if (isAgentKind(this.kind)) {
            this.db.setLastUpdateId(this.kind, updateId);
          }
          const chatKey = telegramUpdateChatKey(update);
          if (!chatKey) continue;
          this.handleUpdate(update, chatKey).catch((error) => {
            console.error(`[${this.kind}] update handling failed`, error);
          });
        }
      } catch (error) {
        const plan = planPollError(error, pollErrState, defaultErrorSleepMs);
        if (plan.logKind === "warn-once") {
          console.warn(`[${this.kind}] ${plan.message}`);
        } else if (plan.logKind === "error-stack") {
          console.error(`[${this.kind}] ${plan.message}`, error);
        }
        await new Promise((r) => setTimeout(r, plan.sleepMs));
      }
    }
  }

  setQueuedMessageHandler(handler: (message: PendingMessage) => Promise<ExecutionOutcome>): void {
    this.queuedMessageHandler = handler;
  }

  async recoverPendingQueues(): Promise<void> {
    await Promise.all(this.db.getPendingLaneKeys(this.surfaceIdentity).map(async (chatKey) => {
      const handle = this.db.acquireLock(this.surfaceIdentity, chatKey);
      if (handle) {
        await this._drainQueueAndUnlock(handle, undefined, 0, false, this.opts.busyMessageMode === "augment");
        return;
      }
      this._scheduleStartupQueueRecovery(chatKey);
    }));
  }

  async recoverPendingQueue(chatKey: string): Promise<boolean> {
    if (this.db.pendingMsgCount(this.surfaceIdentity, chatKey) === 0) return false;
    const handle = this.db.acquireLock(this.surfaceIdentity, chatKey);
    if (handle) {
      await this._drainQueueAndUnlock(handle, undefined, 0, false, this.opts.busyMessageMode === "augment");
      return true;
    }
    this._scheduleStartupQueueRecovery(chatKey);
    return true;
  }

  async handleUpdate(update: TelegramUpdate, providedChatKey?: string): Promise<void> {
    const chatKey = providedChatKey ?? telegramUpdateChatKey(update);
    if (!chatKey) return;
    if (update.callback_query) {
      await this.handleCallback(update.callback_query, chatKey);
      return;
    }
    const turn = adaptTelegramUpdate(update, this.surfaceIdentity, chatKey);
    if (turn) await this.handleInteractiveTurn(turn);
  }

  async handleInteractiveTurn(turn: InteractiveTurnInput): Promise<void> {
    if (turn.surfaceIdentity !== this.surfaceIdentity) throw new Error(`interactive turn surface mismatch: ${turn.surfaceIdentity}`);
    if (!this.opts.allowedUserIds.has(turn.actorId)) return;
    const dedupeKey = `${turn.surfaceIdentity}:${turn.chatKey}:${turn.messageId}`;
    if (this.seenInteractiveMessageKeys.has(dedupeKey)) return;
    this.seenInteractiveMessageKeys.add(dedupeKey);
    while (this.seenInteractiveMessageKeys.size > 4096) {
      const oldest = this.seenInteractiveMessageKeys.values().next().value;
      if (oldest === undefined) break;
      this.seenInteractiveMessageKeys.delete(oldest);
    }
    const rawText = turn.text.trim().toLowerCase();
    if (rawText === "/stop" || rawText === "/cancel") {
      void this._cancelLane(turn.chatKey, "stop").catch((error) => console.error(`[${this.kind}] stop cleanup failed`, error));
      await this.sendText(turn.delivery.chatId, { text: "🛑 Execution aborted by user.", message_thread_id: turn.threadId });
      return;
    }
    await this.mediaBuffer.push(turn);
  }

  /** Compatibility boundary for direct Telegram callers. New surfaces use handleInteractiveTurn. */
  async handleMessages(messages: TelegramMessage[], providedChatKey?: string): Promise<void> {
    const first = messages[0];
    if (!first?.chat) return;
    const chatKey = providedChatKey ?? topicChatKey(first.chat.id, first.chat.type ?? "private", first.message_thread_id);
    const turns = messages.map((message) => adaptTelegramMessage(message, this.surfaceIdentity, chatKey)).filter((turn): turn is InteractiveTurnInput => turn !== null);
    if (turns.length > 0) await this.handleInteractiveMessages(turns);
  }

  async handleInteractiveMessages(messages: InteractiveTurnInput[]): Promise<void> {
    const primaryMessage = messages.find((message) => message.text) ?? messages[0];
    if (!primaryMessage || !this.opts.allowedUserIds.has(primaryMessage.actorId)) return;
    if (messages.some((message) => message.surfaceIdentity !== this.surfaceIdentity || message.chatKey !== primaryMessage.chatKey)) {
      throw new Error("interactive media group crossed surface or conversation boundary");
    }
    const threadId = primaryMessage.threadId;
    const rawText = primaryMessage.text.trim();
    const isSlashCmd = rawText.startsWith("/");
    const commandText = isSlashCmd ? rawText : null;
    const attachmentInputs = messages.flatMap((message) => message.attachments);
    const hasAttachment = attachmentInputs.length > 0;
    const prompt = commandText ? null : (rawText || (hasAttachment ? "Describe the attached file." : null));
    if (!commandText && !prompt) return;

    const chatId = primaryMessage.delivery.chatId;
    const userId = primaryMessage.actorId;
    const chatKey = primaryMessage.chatKey;
    const scheduledOccurrenceKeys = [...new Set(messages.map((message) => message.scheduledOccurrenceKey).filter((key): key is string => Boolean(key)))];
    if (scheduledOccurrenceKeys.length > 1) throw new Error("interactive group crossed scheduled occurrence boundary");
    const executionLane = this._executionLane(chatKey);
    if (!this.laneCoordinator.isResetting(executionLane) && !this.laneCoordinator.hasCancellation(executionLane)) this.laneCoordinator.clearAborted(executionLane);
    const hookCtx: HookContext = { chatId, chatKey, threadId, userId };

    if (commandText) {
      if (this.hooks.onCommand) {
        const hookResult = await this.hooks.onCommand(commandText, hookCtx);
        if (hookResult !== null) {
          if (hookResult.text) await this.sendText(chatId, { text: hookResult.text, reply_markup: hookResult.reply_markup, message_thread_id: threadId });
          return;
        }
      }
      if (isAgentKind(this.kind) && isSlashCmd) {
        let resetHandle: ExecutionLaneHandle | null = null;
        if (commandText === "/reset") {
          this.laneCoordinator.markResetting(executionLane);
          this.laneCoordinator.markAborted(executionLane);
          resetHandle = await abortExecutionAndWait(executionLane);
          const pending = this.db.dequeueMsgs(this.surfaceIdentity, chatKey);
          for (const queued of pending) { this._deleteQueuedAttachments(queued.attachments); this.db.deletePendingMsg(queued.id); }
          this.db.setSetting(`ctx_suppress:${chatKey}`, "1");
        }
        const commandResponse = handleCommand(this.kind, commandText, { db: this.db, chatId: chatKey, config: this._effectiveConfig(), surfaceIdentity: this.surfaceIdentity, defaultBusyMessageMode: this.opts.busyMessageMode ?? "augment" });
        if (commandResponse) {
          if (commandResponse.kind === "message") {
            if (commandText === "/reset") {
              try { await this.sendText(chatId, { text: commandResponse.text, message_thread_id: threadId }); }
              finally { this.laneCoordinator.clearResetting(executionLane); if (resetHandle) this.db.unlock(resetHandle); }
            } else await this.sendText(chatId, { text: commandResponse.text, message_thread_id: threadId });
            return;
          }
          if (commandResponse.kind === "keyboard_message") { await this.sendText(chatId, { text: commandResponse.text, reply_markup: commandResponse.reply_markup, message_thread_id: threadId }); return; }
          if (commandResponse.kind === "codex_usage") {
            try { await this.sendText(chatId, { text: await getCodexUsageText(), message_thread_id: threadId }); }
            catch (error) { await this.sendText(chatId, { text: `Error: ${toUserMessage(error instanceof Error ? error : new Error(String(error)))}`, message_thread_id: threadId }); }
            return;
          }
          if (commandResponse.kind === "execute") { await this._executeAndSend(commandResponse.prompt, chatId, chatKey, primaryMessage.delivery.chatType, threadId, userId, hookCtx, []); return; }
          if (commandResponse.kind === "btw") { await this._executeBtw(commandResponse.prompt, chatId, chatKey, threadId); return; }
        }
        return;
      }
      return;
    }

    const inputRunId = randomUUID();
    const uploadDir = join(tmpdir(), `bridge-uploads-${this.kind}-${chatKey}-${inputRunId}`);
    const attachments: string[] = [];
    let attachmentDownloadFailed = false;
    if (hasAttachment) {
      try {
        for (let index = 0; index < attachmentInputs.length; index += 1) {
          const prefix = attachmentInputs.length > 1 ? `attachment-${index + 1}-` : "";
          const info = await downloadSurfaceAttachment(this.client, attachmentInputs[index], uploadDir, prefix);
          if (!info) { attachmentDownloadFailed = true; break; }
          attachments.push(info.localPath);
        }
      } catch (error) { attachmentDownloadFailed = true; console.error(`[${this.kind}] attachment download failed`, error); }
    }
    if (attachmentDownloadFailed) {
      try { rmSync(uploadDir, { recursive: true, force: true }); } catch {}
      await this.sendText(chatId, { text: "Could not download all attachments. Please upload the album again.", message_thread_id: threadId });
      return;
    }
    const attachmentLocalPath = attachments[0] ?? null;
    let executionOutcome: ExecutionOutcome = "failed";
    const finalDeliveryActive = this.laneCoordinator.hasFinalDelivery(executionLane);
    const augmentMode = (this.opts.busyMessageMode ?? "augment") === "augment";
    const ownsAugmentedTask = augmentMode && !finalDeliveryActive && !this.laneCoordinator.hasAugmentedTask(executionLane);
    if (ownsAugmentedTask) this.laneCoordinator.setAugmentedTask(executionLane, { prompt: prompt!, attachments: [...attachments] });
    try {
      executionOutcome = await this._executeAndSend(prompt!, chatId, chatKey, primaryMessage.delivery.chatType, threadId, userId, hookCtx, attachments, attachmentLocalPath, null, true, true, !finalDeliveryActive, ownsAugmentedTask, true, [], scheduledOccurrenceKeys);
    } finally {
      const transferred = this.laneCoordinator.isAugmentTransferred(executionLane);
      const retainedByCancellation = this.laneCoordinator.hasCancellation(executionLane);
      if (executionOutcome !== "queued" && !transferred && !retainedByCancellation) { try { rmSync(uploadDir, { recursive: true, force: true }); } catch {} }
      if (transferred) this.laneCoordinator.clearAugmentTransferred(executionLane);
      if (ownsAugmentedTask && !retainedByCancellation && !transferred) this.laneCoordinator.clearAugmentedTask(executionLane);
    }
  }

  private async _executeBtw(prompt: string, chatId: number | string, chatKey: string, threadId?: number | string): Promise<void> {
    const executionKind = this._executionKind();
    if (executionKind === "antigravity") {
      await this.sendText(chatId, {
        text: "/btw is unavailable for antigravity: isolated read-only execution cannot be proven without changing shared provider state.",
        message_thread_id: threadId,
      });
      return;
    }
    if (!supportsToolFreeMode(executionKind)) {
      await this.sendText(chatId, {
        text: `/btw is unavailable for ${executionKind}: isolated read-only execution cannot be proven without changing shared provider state.`,
        message_thread_id: threadId,
      });
      return;
    }

    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);
    const cwd = this._workingDir(executionKind);

    const invocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt: prependWorkspaceContext([
        "This is a fresh, read-only side question.",
        "Do not modify files, run write-capable operations, or persist session state.",
        prompt,
      ].join("\n\n")),
      sessionId: null,
      executionMode: "safe",
      outputFormat: "json",
      logFile: null,
      soulContext: this.opts.soulContext,
      attachments: [],
      outputDir: null,
      toolMode: "none",
    });
    const sideExecutionId = `${this._executionLane(chatKey)}:btw:${randomUUID()}`;

    try {
      const stdout = await this.exec.runCli(invocation.command, invocation.args, cwd, {
        ...buildExecutionOptions(executionKind),
        chatId: sideExecutionId,
        stdin: invocation.stdin,
        bypassWorkspaceLock: true,
      });
      const result = parseCliResult({ bot: executionKind, stdout });
      await this.sendText(chatId, { text: result.text, message_thread_id: threadId });
    } catch (error) {
      const userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
      await this.sendText(chatId, { text: `Error: ${userText}`, message_thread_id: threadId });
    }
  }

  private async _executeAndSend(
    rawPrompt: string,
    chatId: number | string,
    chatKey: string,
    chatType: string,
    threadId: number | string | undefined,
    userId: number | string | undefined,
    hookCtx: HookContext,
    attachments: string[],
    attachmentLocalPath: string | null = null,
    laneHandle: ExecutionLaneHandle | null = null,
    drainOnCompletion = true,
    manageLifecycle = true,
    honorBusyMode = false,
    ownsActiveTask = false,
    notifyCapacityFailure = true,
    claimedPendingIds: number[] = [],
    scheduledOccurrenceKeys: string[] = [],
  ): Promise<ExecutionOutcome> {
    void attachmentLocalPath;
    let prompt = rawPrompt;
    if (this.hooks.onBeforeExecute) prompt = await this.hooks.onBeforeExecute(rawPrompt, hookCtx);

    const sessionId = isAgentKind(this.kind) ? this.db.getSession(chatKey, this.kind) : null;
    const activePendingIds: number[] = [];
    let activeTaskCommitted = false;

    if (!laneHandle) {
      const admission = this.db.admitMessage(this.surfaceIdentity, chatKey, {
        prompt, chatId, threadId, chatType, userId, attachments,
        scheduledOccurrenceKey: scheduledOccurrenceKeys[0],
      }, MAX_QUEUE_DEPTH, honorBusyMode && !ownsActiveTask && this.laneCoordinator.hasAugmentedTask(this._executionLane(chatKey)));
      if (admission.kind === "full") {
        await this.sendText(chatId, { text: `⏳ Queue is full (max ${MAX_QUEUE_DEPTH}). Please wait.`, message_thread_id: threadId });
        return "failed";
      }
      if (admission.kind === "queued") {
        const busyMode = honorBusyMode ? this._busyMessageMode(chatKey) : "queue";
        if (busyMode === "interrupt" || busyMode === "augment") {
          if (busyMode === "interrupt") {
            await this.sendText(chatId, { text: `⏹️ Interrupting current work...`, message_thread_id: threadId })
              .catch((error) => console.warn(`[${this.kind}] interrupt notice failed`, error));
          }
          await this._cancelLane(chatKey, busyMode);
          return "queued";
        }
        return "queued";
      }
      if (admission.kind === "execute_claimed") {
        await this._drainQueueAndUnlock(admission.handle, admission.claimed);
        return "queued";
      }
      laneHandle = admission.handle;
    }

    this._assertLaneOwned(laneHandle);
    if (ownsActiveTask && honorBusyMode) {
      this.db.enqueueMsg(this.surfaceIdentity, chatKey, { prompt, chatId, threadId, chatType, userId, attachments, scheduledOccurrenceKey: scheduledOccurrenceKeys[0] });
      const persisted = this.db.claimNextPendingMsg(laneHandle);
      if (!persisted) throw new Error("failed to persist and claim active augmented task");
      activePendingIds.push(persisted.id);
    }

    const executionLane = this._executionLane(chatKey);
    const lifecycleToken = manageLifecycle ? beginExecutionLifecycle(executionLane, laneHandle) : null;
    const lockHeartbeat = manageLifecycle ? setInterval(() => {
      try {
        if (!this.db.heartbeatLock(laneHandle!)) {
          console.error(`[${this.kind}] execution lock lease lost surface=${this.surfaceIdentity} chatKey=${chatKey}`);
          this.laneCoordinator.markAborted(executionLane);
          abortCliProcess(executionLane);
        }
      } catch (error) {
        console.error(`[${this.kind}] execution lock heartbeat failed surface=${this.surfaceIdentity} chatKey=${chatKey}`, error);
      }
    }, this.db.lockHeartbeatMs) : null;
    lockHeartbeat?.unref();

    const { runId, eventContext, collect, finalize } = this._createEventContext(chatId, chatKey, threadId, laneHandle);
    try {
      const result = await this._executeAndDeliverTurn({
        prompt, sessionId, chatId, chatKey, threadId, attachments, laneHandle, runId, eventContext, collect,
      });
      if (!result) {
        // Non-capacity provider failures are swallowed as null after a durable
        // run.failed row may already exist. Link that Run when present.
        this._linkScheduledOccurrences(scheduledOccurrenceKeys, runId);
        return "fenced";
      }
      finalize();
      this._linkScheduledOccurrences(scheduledOccurrenceKeys, runId);
      if (activePendingIds.length && !this.db.completePendingMsgs(laneHandle, activePendingIds)) throw new LostExecutionLeaseError();
      activeTaskCommitted = true;
      return "committed";
    } catch (error) {
      if (error instanceof LostExecutionLeaseError) {
        console.warn(`[${this.kind}] discarded fenced result surface=${this.surfaceIdentity} chatKey=${chatKey}`);
        return "fenced";
      }
      console.error(`[${this.kind}] prompt execution failed`, error);
      if (error instanceof PreviewCleanupError) {
        console.error(`[${this.kind}] abandoned preview cleanup failed; suppressing terminal output`, error.cause);
        const terminalPendingIds = [...new Set([...activePendingIds, ...claimedPendingIds])];
        if (terminalPendingIds.length > 0) {
          const claimedRetired = this.db.completePendingMsgs(laneHandle, terminalPendingIds);
          if (!claimedRetired && !this.db.retireQueuedPendingMsgs(this.surfaceIdentity, chatKey, terminalPendingIds)) {
            console.error(`[${this.kind}] abandoned preview cleanup could not retire owned pending rows`);
            return "fenced";
          }
        }
        return "committed";
      }
      if (error instanceof CliTimeoutError) {
        const pendingTimeout = this.db.dequeueMsgs(this.surfaceIdentity, chatKey);
        for (const queued of pendingTimeout) {
          this._deleteQueuedAttachments(queued.attachments);
          this.db.deletePendingMsg(queued.id);
        }
      }
      try {
        this._linkScheduledOccurrences(scheduledOccurrenceKeys, runId);
      } catch (linkError) {
        console.error(`[${this.kind}] scheduled occurrence correlation failed after execution error`, linkError);
      }
      const capacityExhausted = isCapacityExhaustedError(error instanceof Error ? error : new Error(String(error)));
      if (capacityExhausted && this.hooks.onCapacityExhausted) {
        await this.hooks.onCapacityExhausted(chatKey);
      } else if (!capacityExhausted || notifyCapacityFailure) {
        let userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
        if (capacityExhausted) userText += `\n\n💡 All models for ${this.kind} are currently exhausted. Please try again later.`;
        await sendSurfaceMessage({
          client: this.client,
          kind: this._deliveryKind(),
          chatId,
          body: { text: `Error: ${userText}`, message_thread_id: threadId },
        });
      }
      return "failed";
    } finally {
      if (lockHeartbeat) clearInterval(lockHeartbeat);
      if (!activeTaskCommitted) {
        for (const id of activePendingIds) this.db.releasePendingClaim(laneHandle, id);
      }
      try {
        if (drainOnCompletion && !this.laneCoordinator.isResetting(executionLane) && (activeTaskCommitted || activePendingIds.length === 0)) {
          await this._drainQueueAndUnlock(laneHandle, undefined, 0, true);
        }
        if (!activeTaskCommitted && activePendingIds.length && !this.laneCoordinator.hasCancellation(executionLane) && this.db.ownsLock(laneHandle)) {
          this.db.unlock(laneHandle);
        }
      } finally {
        if (lifecycleToken) completeExecutionLifecycle(executionLane, lifecycleToken);
      }
    }
  }

  private async _executeAndDeliverTurn(input: {
    prompt: string;
    sessionId: string | null;
    chatId: number | string;
    chatKey: string;
    threadId: number | string | undefined;
    attachments: string[];
    laneHandle: ExecutionLaneHandle;
    runId: string;
    eventContext: CliOptions["eventContext"];
    collect: (event: BridgeEvent) => void;
  }): Promise<StagedCliResult | null> {
    let result: StagedCliResult | null = null;
    let finalDeliveryPhase: FinalDeliveryPhase | null = null;
    try {
      const delivered = await sendMessageWithProgress({
        client: this.client,
        kind: this._deliveryKind(),
        chatId: input.chatId,
        body: { message_thread_id: input.threadId },
        showProgressNarration: this.kind === "antigravity" && isAntigravityNarrationVisible(this.db, input.chatKey),
        isAborted: () => this.laneCoordinator.isAborted(this._executionLane(input.chatKey)) || !this.db.ownsLock(input.laneHandle),
        beforeFinalDelivery: () => {
          finalDeliveryPhase = this._claimFinalDeliveryPhase(input.laneHandle);
          return finalDeliveryPhase !== null;
        },
        propagateExecutionErrors: false,
        propagateTimeoutErrors: true,
        runId: input.runId,
        onEvent: input.collect,
        execution: async (onProgress: (text: string) => void, onAnswerDelta: (text: string) => void) => {
          const executionKind = this._executionKind();
          const answerDecoder = executionKind === "claude"
            ? createClaudeAnswerPresentationDecoder(onAnswerDelta)
            : executionKind === "antigravity"
              ? createAntigravityAnswerPresentationDecoder(onAnswerDelta)
              : null;
          const body = {
            message_thread_id: input.threadId,
            onProviderOutputChunk: answerDecoder ? (chunk: string) => answerDecoder.push(chunk) : undefined,
            onProviderOutputFinished: answerDecoder ? () => answerDecoder.finish() : undefined,
          };
          result = await this.executePromptAsync(
            input.prompt, input.sessionId, input.chatId, body, onProgress, input.attachments,
            input.eventContext, input.runId, input.collect, input.chatKey, input.laneHandle,
          );
          return result;
        },
        afterFinalDelivery: () => {
          if (!result) throw new Error("missing staged CLI result at final delivery");
          this._commitResultState(input.laneHandle, input.prompt, result);
        },
      });
      return delivered ? result : null;
    } finally {
      this._releaseFinalDeliveryPhase(input.laneHandle, finalDeliveryPhase);
    }
  }

  private _linkScheduledOccurrences(scheduledOccurrenceKeys: string[], runId: string): void {
    if (scheduledOccurrenceKeys.length === 0) return;
    // Only bind when a durable Run row exists. Fence/pre-start failures leave
    // run_not_created instead of inventing an unreachable Run ID.
    if (!this.db.getRun(runId)) return;
    for (const occurrenceKey of scheduledOccurrenceKeys) {
      if (!linkScheduledOccurrenceRun(this.db, occurrenceKey, runId)) {
        throw new Error(`scheduled occurrence correlation unavailable: ${occurrenceKey}`);
      }
    }
  }

  private _createEventContext(chatId: number | string, chatKey: string, threadId: number | string | undefined, laneHandle: ExecutionLaneHandle, existingRunId?: string): {
    runId: string;
    eventContext: CliOptions["eventContext"];
    collect: (e: BridgeEvent) => void;
    finalize: () => void;
    events: BridgeEvent[];
  } {
    const runId = existingRunId ?? randomUUID();
    const eventContext = {
      runId,
      bot: (isAgentKind(this.kind) ? this.kind : "claude") as BotKind,
      chatId: String(chatId),
      chatKey,
      threadId: threadId != null ? String(threadId) : undefined,
      serviceId: laneHandle.serviceId,
      acquisitionId: laneHandle.acquisitionId,
    };
    const events: BridgeEvent[] = [];
    const store = new EventStore(this.db, existingRunId);

    const collect = (e: BridgeEvent) => {
      events.push(e);
      if (e.type === "run.completed") {
        store.queueCompleted(e);
      } else {
        store.collect(e);
      }
    };
    const finalize = () => store.finalize();
    return { runId, eventContext, collect, finalize, events };
  }

  private _discardPendingMessages(chatKey: string): void {
    const pending = this.db.dequeueMsgs(this.surfaceIdentity, chatKey);
    for (const queued of pending) {
      this._deleteQueuedAttachments(queued.attachments);
      this.db.deletePendingMsg(queued.id);
    }
  }

  private _cancelLane(chatKey: string, mode: "augment" | "interrupt" | "stop"): Promise<void> {
    const executionLane = this._executionLane(chatKey);
    const existing = this.laneCoordinator.getCancellation(executionLane);
    if (existing) {
      if (mode === "stop" && existing.mode !== "stop") {
        existing.mode = "stop";
        this._installStopFence(chatKey, executionLane);
      }
      return existing.promise;
    }

    const record = { mode, promise: Promise.resolve() } as LaneCancellation;
    if (mode === "stop") this._installStopFence(chatKey, executionLane);
    this.laneCoordinator.setCancellation(executionLane, record);

    const operation = (async () => {
      const finalDelivery = this.laneCoordinator.getFinalDelivery(executionLane);
      if (finalDelivery && record.mode === "augment") {
        await finalDelivery.promise;
        if (record.mode === "augment") return;
      }
      if (finalDelivery && record.mode !== "stop") await finalDelivery.promise;
      if (record.mode !== "stop") {
        this.laneCoordinator.markResetting(executionLane);
        this.laneCoordinator.markAborted(executionLane);
      }
      let handle: ExecutionLaneHandle | null = null;
      try {
        if (record.mode === "stop") this._discardPendingMessages(chatKey);
        handle = await abortExecutionAndWait(executionLane);
        this.laneCoordinator.clearAborted(executionLane);
        this.laneCoordinator.clearResetting(executionLane);
        const activeDrainer = this.laneCoordinator.getDrainer(executionLane);
        if (activeDrainer && record.mode !== "augment") await activeDrainer.promise;
        if (record.mode === "augment") await new Promise<void>((resolve) => setImmediate(resolve));
        if (activeDrainer) await activeDrainer.promise;
        if (record.mode === "augment") this.laneCoordinator.markAugmentTransferred(executionLane);
        this.laneCoordinator.clearCancellation(executionLane, record);
        if (handle) await this._drainQueueAndUnlock(handle, undefined, 0, false, record.mode === "augment");
        if (!this.laneCoordinator.hasCancellation(executionLane)) this.laneCoordinator.clearAugmentedTask(executionLane);
      } finally {
        if (this.laneCoordinator.getCancellation(executionLane) === record) {
          this.laneCoordinator.clearAborted(executionLane);
          this.laneCoordinator.clearResetting(executionLane);
          this.laneCoordinator.clearCancellation(executionLane);
        }
        if (handle && !this.laneCoordinator.hasCancellation(executionLane) && this.db.ownsLock(handle)) this.db.unlock(handle);
      }
    })().finally(() => {
      if (this.laneCoordinator.getCancellation(executionLane) === record) {
        this.laneCoordinator.clearAborted(executionLane);
        this.laneCoordinator.clearResetting(executionLane);
        this.laneCoordinator.clearCancellation(executionLane);
      }
    });

    record.promise = operation;
    return record.promise;
  }

  private _installStopFence(chatKey: string, executionLane: string): void {
    this.laneCoordinator.markResetting(executionLane);
    this.laneCoordinator.markAborted(executionLane);
    this._discardPendingMessages(chatKey);
  }

  private _canPublish(handle: ExecutionLaneHandle): boolean {
    return !this.laneCoordinator.isAborted(this._executionLane(handle.chatKey)) && this.db.ownsLock(handle);
  }

  private async _drainQueueAndUnlock(handle: ExecutionLaneHandle, initial?: PendingMessage, recoveryAttempt = 0, lifecycleAlreadyManaged = false, coalesce = false, augmentation?: AugmentedTask): Promise<void> {
    const executionLane = this._executionLane(handle.chatKey);
    const existing = this.laneCoordinator.getDrainer(executionLane);
    if (existing) return existing.promise;

    const record = { promise: Promise.resolve() } as LaneDrainer;
    const operation = this._drainQueueAndUnlockOwned(handle, initial, recoveryAttempt, lifecycleAlreadyManaged, coalesce, augmentation);
    record.promise = operation.finally(() => {
      this.laneCoordinator.clearDrainer(executionLane, record);
    });
    this.laneCoordinator.setDrainer(executionLane, record);
    return record.promise;
  }

  private _claimFinalDeliveryPhase(handle: ExecutionLaneHandle): FinalDeliveryPhase | null {
    const executionLane = this._executionLane(handle.chatKey);
    if (this.laneCoordinator.isAborted(executionLane) || this.laneCoordinator.hasFinalDelivery(executionLane)) return null;
    try {
      this._runWithFence(handle, () => undefined);
    } catch (error) {
      if (error instanceof LostExecutionLeaseError) return null;
      throw error;
    }

    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const phase = { promise, release };
    this.laneCoordinator.setFinalDelivery(executionLane, phase);
    return phase;
  }

  private _releaseFinalDeliveryPhase(handle: ExecutionLaneHandle, phase: FinalDeliveryPhase | null): void {
    if (!phase) return;
    const executionLane = this._executionLane(handle.chatKey);
    if (this.laneCoordinator.getFinalDelivery(executionLane) !== phase) return;
    this.laneCoordinator.clearFinalDelivery(executionLane, phase);
    phase.release();
  }

  private async _drainQueueAndUnlockOwned(
    handle: ExecutionLaneHandle,
    initial: PendingMessage | undefined,
    recoveryAttempt: number,
    lifecycleAlreadyManaged: boolean,
    coalesce: boolean,
    augmentation?: AugmentedTask,
  ): Promise<void> {
    const chatKey = handle.chatKey;
    const executionLane = this._executionLane(chatKey);
    const scheduled = this.queueRecoveryTimers.get(chatKey);
    if (scheduled) {
      clearTimeout(scheduled);
      this.queueRecoveryTimers.delete(chatKey);
    }
    let nextPending = initial;
    for (;;) {
      const claimed: PendingMessage[] = nextPending ? [nextPending] : (coalesce ? this.db.claimPendingMsgs(handle) : (() => {
        const one = this.db.claimNextPendingMsg(handle);
        return one ? [one] : [];
      })());
      const next = claimed.length === 0 ? null : claimed.length === 1 && !augmentation ? {
        ...claimed[0],
        queueRecoveryAttempt: recoveryAttempt,
      } : {
        ...claimed[0],
        prompt: [...(augmentation ? [augmentation.prompt] : []), ...claimed.map((row) => row.prompt)].join("\n\n"),
        attachments: [...(augmentation?.attachments ?? []), ...claimed.flatMap((row) => row.attachments)],
        pendingIds: claimed.map((row) => row.id),
        scheduledOccurrenceKeys: [...new Set(claimed.map((row) => row.scheduledOccurrenceKey).filter((key): key is string => Boolean(key)))],
        queueRecoveryAttempt: recoveryAttempt,
      };
      nextPending = undefined;
      if (!next) {
        if (this.db.pendingMsgCount(this.surfaceIdentity, chatKey) > 0) return;
        if (this.db.unlockIfQueueEmpty(handle)) {
          if (!this.laneCoordinator.hasCancellation(executionLane)) this.laneCoordinator.clearAugmentedTask(executionLane);
          return;
        }
        if (!this.db.ownsLock(handle)) return;
        continue;
      }
      try {
        const outcome = this.queuedMessageHandler
          ? await this.queuedMessageHandler({ ...next, laneHandle: handle, laneLifecycleManaged: lifecycleAlreadyManaged })
          : await this.executeClaimedMessage({ ...next, laneHandle: handle, laneLifecycleManaged: lifecycleAlreadyManaged });
        if (outcome === "fenced") {
          for (const id of next.pendingIds ?? [next.id]) this.db.releasePendingClaim(handle, id);
          return;
        }
        if (outcome !== "committed") {
          for (const id of next.pendingIds ?? [next.id]) this.db.releasePendingClaim(handle, id);
          this.db.unlock(handle);
          if (this.laneCoordinator.isAborted(executionLane) || this.laneCoordinator.hasCancellation(executionLane)) return;
          this._scheduleQueueRecovery(chatKey, recoveryAttempt + 1);
          return;
        }
        if (!(next.pendingIds ? this.db.completePendingMsgs(handle, next.pendingIds) : this.db.completePendingMsg(handle, next.id))) return;
        this._deleteQueuedAttachments(next.attachments);
      } catch (error) {
        for (const id of next.pendingIds ?? [next.id]) this.db.releasePendingClaim(handle, id);
        this.db.unlock(handle);
        console.error(`[${this.kind}] queued handoff failed`, error);
        this._scheduleQueueRecovery(chatKey, recoveryAttempt + 1);
        return;
      }
    }
  }

  private _scheduleQueueRecovery(chatKey: string, attempt: number): void {
    if (attempt > 3 || this.queueRecoveryTimers.has(chatKey)) return;
    const timer = setTimeout(() => {
      this.queueRecoveryTimers.delete(chatKey);
      try {
        const handle = this.db.acquireLock(this.surfaceIdentity, chatKey);
        if (!handle) return;
        void this._drainQueueAndUnlock(handle, undefined, attempt).catch((error) =>
          console.error(`[${this.kind}] queue recovery failed chatKey=${chatKey}`, error)
        );
      } catch (error) {
        console.error(`[${this.kind}] queue recovery could not acquire lane chatKey=${chatKey}`, error);
      }
    }, Math.min(1_000, 100 * (2 ** (attempt - 1))));
    timer.unref();
    this.queueRecoveryTimers.set(chatKey, timer);
  }

  private _scheduleStartupQueueRecovery(chatKey: string): void {
    if (this.startupQueueRecoveryTimers.has(chatKey)) return;
    const timer = setTimeout(() => {
      this.startupQueueRecoveryTimers.delete(chatKey);
      if (this.db.pendingMsgCount(this.surfaceIdentity, chatKey) === 0) return;
      const handle = this.db.acquireLock(this.surfaceIdentity, chatKey);
      if (!handle) {
        this._scheduleStartupQueueRecovery(chatKey);
        return;
      }
      void this._drainQueueAndUnlock(
        handle,
        undefined,
        0,
        false,
        this.opts.busyMessageMode === "augment",
      ).catch((error) => {
        console.error(`[${this.kind}] startup queue recovery failed chatKey=${chatKey}`, error);
      });
    }, this.db.lockHeartbeatMs);
    timer.unref();
    this.startupQueueRecoveryTimers.set(chatKey, timer);
  }

  async executeClaimedMessage(next: PendingMessage): Promise<ExecutionOutcome> {
    if (!next.laneHandle) throw new Error("claimed message requires its acquisition handle");
    const chatKey = next.chatKey;
    if (this.opts.busyMessageMode === "augment") {
      this.laneCoordinator.setAugmentedTask(this._executionLane(chatKey), { prompt: next.prompt, attachments: [...next.attachments] });
    }
    const hookCtx: HookContext = { chatId: next.chatId, chatKey, threadId: next.threadId ?? undefined, userId: next.userId ?? undefined };
    return this._executeAndSend(
      next.prompt, next.chatId, chatKey, next.chatType, next.threadId ?? undefined,
      next.userId ?? undefined, hookCtx, next.attachments, null, next.laneHandle,
      false, !next.laneLifecycleManaged, false, false,
      next.queueRecoveryAttempt == null || next.queueRecoveryAttempt >= MAX_QUEUE_RECOVERY_ATTEMPTS,
      next.pendingIds ?? [next.id],
      next.scheduledOccurrenceKeys ?? (next.scheduledOccurrenceKey ? [next.scheduledOccurrenceKey] : []),
    );
  }

  private _deleteQueuedAttachments(attachments: string[]): void {
    const uploadDirs = new Set<string>();
    for (const attachment of attachments) {
      const parent = dirname(attachment);
      if (dirname(parent) !== tmpdir() || !basename(parent).startsWith("bridge-uploads-")) continue;
      try { unlinkSync(attachment); } catch {}
      uploadDirs.add(parent);
    }
    for (const dir of uploadDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  private _assertLaneOwned(handle: ExecutionLaneHandle): void {
    if (this.laneCoordinator.isAborted(this._executionLane(handle.chatKey)) || !this.db.ownsLock(handle)) {
      throw new LostExecutionLeaseError();
    }
  }

  private _renewLaneOrThrow(handle: ExecutionLaneHandle): void {
    if (this.laneCoordinator.isAborted(this._executionLane(handle.chatKey)) || !this.db.heartbeatLock(handle)) {
      throw new LostExecutionLeaseError();
    }
  }

  private _stageResultState(result: CliResult): StagedCliResult {
    return { ...result };
  }

  private _commitResultState(handle: ExecutionLaneHandle, prompt: string, result: StagedCliResult): void {
    const chatKey = handle.chatKey;
    this._runWithFence(handle, () => {
      if (result.sessionId && isAgentKind(this.kind)) {
        db_setSession(this.db, chatKey, this.kind, result.sessionId);
        if (result.nativeSessionMode === "fresh") clearHandoffRequired(this.db, chatKey, this.kind);
      }
      if (isAgentKind(this.kind)) this.db.resetFailures(chatKey, this.kind);
      if (isAgentKind(this.kind)) this._rememberTurn(chatKey, prompt, result.text);
    });
  }

  private _runWithFence<T>(handle: ExecutionLaneHandle, operation: () => T): T {
    this._assertLaneOwned(handle);
    try {
      return this.db.runWithLockFence(handle, operation);
    } catch (error) {
      if (error instanceof ExecutionLockLostError) throw new LostExecutionLeaseError();
      throw error;
    }
  }

  private _executionLane(chatKey: string): string {
    return JSON.stringify([this.surfaceIdentity, chatKey]);
  }

  private _conversationOwnerKey(): string | null {
    return deriveConversationOwnerKey(this.surfaceIdentity, this.opts.allowedUserIds);
  }

  private _rememberTurn(chatKey: string, userPrompt: string, assistantText: string): void {
    const ownerKey = this._conversationOwnerKey();
    const provenance = { surfaceIdentity: this.surfaceIdentity, ...(ownerKey ? { ownerKey } : {}) };
    this.db.addConvTurn(chatKey, "user", trimTurnText(userPrompt), this.kind, provenance);
    this.db.addConvTurn(chatKey, "assistant", trimTurnText(assistantText), this.kind, provenance);
  }

  private _shouldInjectContext(chatKey: string, nativeSessionMode: "fresh" | "resume"): boolean {
    if (this.db.getSetting(`ctx_suppress:${chatKey}`)) return false;
    return nativeSessionMode === "fresh";
  }

  private _buildRecentContextPrompt(chatKey: string, prompt: string, nativeSessionMode: "fresh" | "resume"): string {
    if (!this._shouldInjectContext(chatKey, nativeSessionMode)) return prompt;
    const ctx = this.db.buildConvContext(chatKey, ENGINE_CONTEXT_MAX_CHARS, this.surfaceIdentity);
    return ctx ? `${ctx}${prompt}` : prompt;
  }

  private _buildContextAccess(chatKey: string): { prompt: string; env: Record<string, string> } | null {
    const dbPath = this.opts.fullConfig?.dbPath;
    const status = this.db.getConvStatus(chatKey, this.surfaceIdentity);
    const hasContext = !!dbPath && status.turnCount > 0;
    const commandPath = join(process.cwd(), "bin", "agent-bridge-context");
    const advisorCommandPath = join(process.cwd(), "bin", "agent-bridge-advisor");
    const turnKey = `${chatKey}:${randomUUID()}`;
    let advisorCapability: string | null = null;
    if (this.opts.advisorCapabilities) {
      try {
        advisorCapability = this.opts.advisorCapabilities.issue({
          chatKey,
          cliKind: this.kind,
          turnKey,
          taskKey: turnKey,
          repoPath: this._workingDir(this._executionKind()),
        });
      } catch (error) {
        console.warn("[advisor] capability unavailable:", error);
      }
    }
    if (!hasContext && !advisorCapability) return null;
    const ownerKey = this._conversationOwnerKey();
    const contextPrompt = hasContext ? [
      "[Agent Bridge context]",
      "More retained conversation turns are available if needed:",
      '"$AGENT_BRIDGE_CONTEXT_COMMAND" --recent 20',
      '"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"',
      ...(ownerKey ? ['"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>" --scope owner'] : []),
      "",
    ].join("\n") : "";
    return {
      prompt: contextPrompt,
      env: {
        ...(hasContext ? {
          AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
          AGENT_BRIDGE_CONTEXT_COMMAND: commandPath,
          AGENT_BRIDGE_CONTEXT_DB: dbPath!,
          AGENT_BRIDGE_CHAT_KEY: chatKey,
          AGENT_BRIDGE_SURFACE_IDENTITY: this.surfaceIdentity,
          ...(ownerKey ? { AGENT_BRIDGE_OWNER_KEY: ownerKey } : {}),
        } : {}),
        ...(advisorCapability ? {
          AGENT_BRIDGE_ADVISOR_COMMAND: advisorCommandPath,
          AGENT_BRIDGE_ADVISOR_CAPABILITY: advisorCapability,
        } : {}),
      },
    };
  }

  private async _buildPromptForCli(chatKey: string, prompt: string, nativeSessionMode: "fresh" | "resume", model: string | null): Promise<{ prompt: string; contextEnv?: Record<string, string>; soulContext: string | null; includeResponseContract: boolean }> {
    const shouldInject = this._shouldInjectContext(chatKey, nativeSessionMode);
    const contextPrompt = this._buildRecentContextPrompt(chatKey, prompt, nativeSessionMode);
    const access = this._buildContextAccess(chatKey);
    const workspacePrompt = this.opts.workspaceContext === undefined
      ? prependWorkspaceContext(contextPrompt)
      : (this.opts.workspaceContext ? `[Managed workspace context]\n${this.opts.workspaceContext}\n\n${contextPrompt}` : contextPrompt);
    const fallbackPrompt = nativeSessionMode === "fresh" && isAgentKind(this.kind) && isProviderFallbackHandoffRequired(this.db, chatKey, this.kind)
      ? prependProviderFallbackContinuation(workspacePrompt)
      : workspacePrompt;
    const handoffPrompt = shouldInject ? prependHandoffModel(fallbackPrompt, model) : fallbackPrompt;
    const soulContext = shouldInject ? this.opts.soulContext ?? null : null;
    if (!access) return { prompt: handoffPrompt, soulContext, includeResponseContract: shouldInject };
    return {
      prompt: shouldInject ? `${access.prompt}${handoffPrompt}` : handoffPrompt,
      contextEnv: access.env,
      soulContext,
      includeResponseContract: shouldInject,
    };
  }

  async executePromptAsync(
    prompt: string,
    sessionId: string | null,
    chatId: number | string,
    body: any = {},
    onProgress = (_text: string) => {},
    attachments: string[] = [],
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    chatKey: string = String(chatId),
    laneHandle: ExecutionLaneHandle = undefined as never,
  ): Promise<StagedCliResult> {
    return this._executeProviderAttempt(
      prompt,
      sessionId,
      chatId,
      body,
      onProgress,
      attachments,
      eventContext,
      runId,
      collect,
      chatKey,
      laneHandle,
    );
  }

  async executeSurfaceNeutralTurn(input: SurfaceNeutralTurnInput): Promise<StagedCliResult> {
    const executionLane = this._executionLane(input.chatKey);
    const lifecycleToken = beginExecutionLifecycle(executionLane, input.laneHandle);
    const lockHeartbeat = setInterval(() => {
      try {
        if (!this.db.heartbeatLock(input.laneHandle)) {
          this.laneCoordinator.markAborted(executionLane);
          abortCliProcess(executionLane);
        }
      } catch (error) {
        console.error(`[${this.kind}] surface-neutral execution lock heartbeat failed chatKey=${input.chatKey}`, error);
      }
    }, this.db.lockHeartbeatMs);
    lockHeartbeat.unref();
    try {
      return await this.executePromptAsync(
        input.prompt,
        input.sessionId,
        input.chatId,
        { onProviderExecutionStarted: input.onProviderExecutionStarted },
        () => {},
        [],
        input.eventContext,
        input.runId,
        input.collect,
        input.chatKey,
        input.laneHandle,
      );
    } finally {
      clearInterval(lockHeartbeat);
      completeExecutionLifecycle(executionLane, lifecycleToken);
    }
  }

  private async _executeProviderAttempt(
    prompt: string,
    sessionId: string | null,
    chatId: number | string,
    body: any,
    onProgress: (text: string) => void,
    attachments: string[],
    eventContext: CliOptions["eventContext"],
    runId: string | null,
    collect: ((e: BridgeEvent) => void) | null,
    chatKey: string,
    laneHandle: ExecutionLaneHandle,
  ): Promise<StagedCliResult> {
    if (!laneHandle) throw new Error("execution lane handle is required");
    const threadId = body.message_thread_id;
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);

    let logFile: string | null = null;
    if (executionKind === "antigravity") {
      logFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    }

    const fileSendOptions = threadId != null ? { message_thread_id: threadId } : undefined;
    const outDir = await prepareOutputDir(chatKey, this.kind, runId ?? randomUUID());
    const cwd = this._workingDir(executionKind);
    const startedAtMs = Date.now();
    if (executionKind === "antigravity") setAntigravityModel(model);
    const nativeSessionMode = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt: "",
      sessionId,
      executionMode: this.opts.executionMode,
      outputFormat: null,
      logFile,
      soulContext: null,
      includeResponseContract: false,
      attachments,
      outputDir: null,
    }).nativeSessionMode;
    const promptForCli = await this._buildPromptForCli(chatKey, prompt, nativeSessionMode, model);
    const invocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      effort: resolveEffort(executionKind, this.db),
      prompt: promptForCli.prompt,
      sessionId,
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" || executionKind === "claude"
        ? "stream-json"
        : executionKind === "grok"
          ? "streaming-json"
          : "json",
      logFile,
      soulContext: promptForCli.soulContext,
      includeResponseContract: promptForCli.includeResponseContract,
      attachments,
      outputDir: outDir,
      nativeCompletion: true,
    });
    const isClaudeStreamJson = executionKind === "claude"
      && invocation.args.includes("stream-json");
    try {
      let stdout: string;
      try {
        (body as { onProviderExecutionStarted?: () => void }).onProviderExecutionStarted?.();
        stdout = (await this.exec.runCliAsync(invocation.command, invocation.args, cwd, {
          ...buildExecutionOptions(executionKind),
          onProgress,
          onProviderOutputChunk: (body as { onProviderOutputChunk?: (chunk: string) => void }).onProviderOutputChunk,
          chatId: this._executionLane(chatKey),
          stdin: invocation.stdin,
          contextEnv: promptForCli.contextEnv,
          eventContext,
          onEvent: collect ?? undefined,
        })).text;
      } finally {
        (body as { onProviderOutputFinished?: () => void }).onProviderOutputFinished?.();
      }

      this._assertLaneOwned(laneHandle);

      let logContent: string | null = null;
      if (logFile) {
        try { logContent = readFileSync(logFile, "utf8"); } catch {} finally { try { rmSync(logFile); } catch {} }
      }

      let result: CliResult;
      if (isClaudeStreamJson) {
        const parsed = parseClaudeStreamJsonOutput(stdout);
        result = parsed ?? { text: stdout.trim(), sessionId: null };
      } else {
        const outputFormat = executionKind === "antigravity"
          ? (invocation.args.includes("stream-json") ? "stream-json" : (invocation.args.includes("json") ? "json" : "text"))
          : undefined;
        result = parseCliResult({ bot: executionKind, stdout, logContent, outputFormat });
      }
      if (executionKind === "antigravity" && !result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd, sinceMs: startedAtMs, explicitLogContent: logContent });
      }
      result.text = scrubOutputDir(result.text, outDir);
      const stagedResult: StagedCliResult = { ...this._stageResultState(result), nativeSessionMode };
      this._renewLaneOrThrow(laneHandle);
      if (this.hooks.onAfterExecute) {
        await this.hooks.onAfterExecute(prompt, stagedResult.text, hookContext(chatId, chatKey, body.message_thread_id));
      }
      this._renewLaneOrThrow(laneHandle);
      if (this._canPublish(laneHandle)) {
        await uploadOutputFiles(outDir, chatId, this.client, fileSendOptions, () => this._canPublish(laneHandle)).catch((err) =>
          console.error(`[${this.kind}] output file upload failed`, err)
        );
      }
      if (collect && runId && eventContext) {
        collect({
          type: "run.completed",
          version: 1,
          id: randomUUID(),
          runId,
          timestamp: new Date().toISOString(),
          bot: eventContext.bot,
          chatId: eventContext.chatId,
          chatKey: eventContext.chatKey,
          threadId: eventContext.threadId,
          sessionId: stagedResult.sessionId ?? null,
          text: stagedResult.text,
        });
      }
      return stagedResult;
    } catch (error) {
      if (logFile) { try { rmSync(logFile); } catch {} }
      if (error instanceof LostExecutionLeaseError) throw error;
      if (this._canPublish(laneHandle)) await uploadOutputFiles(outDir, chatId, this.client, fileSendOptions, () => this._canPublish(laneHandle)).catch(() => {});
      if (sessionId && /No conversation found with session ID|thread not found|session not found|conversation not found/i.test((error as Error).message ?? "")) {
        console.warn(`[${this.kind}] session ID invalid, retrying with fresh session...`);
        if (isAgentKind(this.kind)) this._runWithFence(laneHandle, () => db_setSession(this.db, chatKey, this.kind as BotKind, null));
        return this.executePromptAsync(prompt, null, chatId, body, onProgress, attachments, eventContext, runId, collect, chatKey, laneHandle);
      }
      if (executionKind === "antigravity" && (isAntigravityPrintTimeoutError(error as Error) || isRecoverableAntigravityExecutionError(error as Error))) {
        return this._retryAntigravityFreshSession(prompt, chatId, chatKey, outDir, onProgress, attachments, laneHandle, eventContext, runId, collect, body.message_thread_id, body);
      }
      if (isCapacityExhaustedError(error as Error) && this.opts.botConfig.modelPreference.length > 1) {
        const fallbackModel = getNextFallbackModel(model, this.opts.botConfig.modelPreference);
        if (fallbackModel) {
          return this._runWithFallback(
            prompt, sessionId, chatId, chatKey, fallbackModel, outDir, cwd, startedAtMs, onProgress,
            attachments, logFile, laneHandle, eventContext, runId, collect, body,
          );
        }
      }
      this._handleCircuitBreaker(error as Error, chatKey, laneHandle);
      throw error;
    }
  }

  private async _runFreshAntigravityRetry(
    prompt: string,
    chatId: number | string,
    chatKey: string,
    outDir: string,
    onProgress: (t: string) => void,
    attachments: string[],
    laneHandle: ExecutionLaneHandle,
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    soulContext: string | null = null,
    includeResponseContract = true,
    body: any = {},
  ): Promise<StagedCliResult> {
    const executionKind = this._executionKind();
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);
    const retryLogFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    const retryCwd = this._workingDir(executionKind);
    const retryStartedAtMs = Date.now();
    setAntigravityModel(model);
    const retryInvocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model,
      prompt,
      sessionId: null,
      sessionMode: "resume",
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" || executionKind === "claude"
        ? "stream-json"
        : executionKind === "grok"
          ? "streaming-json"
          : "json",
      logFile: retryLogFile,
      soulContext,
      includeResponseContract,
      outputDir: outDir,
      attachments,
      nativeCompletion: true,
    });

    try {
      let rawResult: string;
      try {
        rawResult = (await this.exec.runCliAsync(retryInvocation.command, retryInvocation.args, retryCwd, {
          ...buildExecutionOptions(executionKind),
          onProgress,
          onProviderOutputChunk: body.onProviderOutputChunk,
          chatId: this._executionLane(chatKey),
          stdin: retryInvocation.stdin,
          eventContext,
          onEvent: collect ?? undefined,
        })).text;
      } finally {
        body.onProviderOutputFinished?.();
      }
      this._assertLaneOwned(laneHandle);

      let retryLogContent: string | null = null;
      try { retryLogContent = readFileSync(retryLogFile, "utf8"); } catch {}
      finally { try { rmSync(retryLogFile); } catch {} }

      const outputFormat = executionKind === "antigravity"
        ? (retryInvocation.args.includes("stream-json") ? "stream-json" : (retryInvocation.args.includes("json") ? "json" : "text"))
        : undefined;
      const result = parseCliResult({ bot: executionKind, stdout: rawResult, logContent: retryLogContent, outputFormat });
      if (!result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd: retryCwd, sinceMs: retryStartedAtMs, explicitLogContent: retryLogContent });
      }
      result.text = scrubOutputDir(result.text, outDir);
      const stagedResult: StagedCliResult = { ...this._stageResultState(result), nativeSessionMode: "fresh" };
      if (collect && runId && eventContext) {
        collect({
          type: "run.completed",
          version: 1,
          id: randomUUID(),
          runId,
          timestamp: new Date().toISOString(),
          bot: eventContext.bot,
          chatId: eventContext.chatId,
          chatKey: eventContext.chatKey,
          threadId: eventContext.threadId,
          sessionId: stagedResult.sessionId ?? null,
          text: stagedResult.text,
        });
      }
      return stagedResult;
    } catch (retryError) {
      try { rmSync(retryLogFile); } catch {}
      throw retryError;
    }
  }

  private async _retryAntigravityFreshSession(
    prompt: string,
    chatId: number | string,
    chatKey: string,
    outDir: string,
    onProgress: (t: string) => void,
    attachments: string[],
    laneHandle: ExecutionLaneHandle,
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    bodyThreadId?: number | string,
    body: any = {},
  ): Promise<StagedCliResult> {
    if (isAgentKind(this.kind)) this._runWithFence(laneHandle, () => db_setSession(this.db, chatKey, this.kind as BotKind, null));
    const model = isAgentKind(this.kind)
      ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null)
      : (this.opts.botConfig.modelPreference[0] || null);
    const retryPromptForCli = await this._buildPromptForCli(chatKey, prompt, "fresh", model);
    const maxFreshAttempts = 2;
    let retryResult: StagedCliResult | null = null;
    for (let attempt = 1; attempt <= maxFreshAttempts; attempt++) {
      try {
        retryResult = await this._runFreshAntigravityRetry(
          retryPromptForCli.prompt,
          chatId,
          chatKey,
          outDir,
          onProgress,
          attachments,
          laneHandle,
          eventContext,
          runId,
          collect,
          retryPromptForCli.soulContext,
          retryPromptForCli.includeResponseContract,
          body,
        );
        break;
      } catch (retryError) {
        const err = retryError instanceof Error ? retryError : new Error(String(retryError));
        if (!(isAntigravityPrintTimeoutError(err) || isRecoverableAntigravityExecutionError(err))) throw err;
        console.warn(`[${this.kind}] fresh-session retry ${attempt}/${maxFreshAttempts} failed with recoverable Agy error`, err.message);
        if (isAgentKind(this.kind)) this._runWithFence(laneHandle, () => db_setSession(this.db, chatKey, this.kind as BotKind, null));
        if (attempt === maxFreshAttempts) {
          throw new Error("Agy failed repeatedly with an internal cascade error. The session was reset — please resend your message.");
        }
      }
    }
    if (!retryResult) throw new Error("Agy fresh-session retry produced no result.");
    this._renewLaneOrThrow(laneHandle);
    if (this.hooks.onAfterExecute) {
      await this.hooks.onAfterExecute(prompt, retryResult.text, hookContext(chatId, chatKey, bodyThreadId));
    }
    return retryResult;
  }

  private async _runWithFallback(
    prompt: string,
    sessionId: string | null,
    chatId: number | string,
    chatKey: string,
    fallbackModel: string,
    outDir: string,
    cwd: string,
    _startedAtMs: number,
    onProgress: (t: string) => void,
    attachments: string[],
    _logFile: string | null,
    laneHandle: ExecutionLaneHandle,
    eventContext: CliOptions["eventContext"] = undefined as any,
    runId: string | null = null,
    collect: ((e: BridgeEvent) => void) | null = null,
    body: any = {},
  ): Promise<StagedCliResult> {
    const executionKind = this._executionKind();
    let fallbackLogFile: string | null = null;
    if (executionKind === "antigravity") {
      fallbackLogFile = join(tmpdir(), `antigravity-${randomUUID()}.log`);
    }
    if (executionKind === "antigravity") setAntigravityModel(fallbackModel);
    const fallbackPromptForCli = await this._buildPromptForCli(chatKey, prompt, "fresh", fallbackModel);
    const fallbackInvocation = buildCliInvocation({
      bot: executionKind,
      command: this.opts.botConfig.command,
      model: fallbackModel,
      effort: resolveEffort(executionKind, this.db),
      prompt: fallbackPromptForCli.prompt,
      sessionId: null,
      sessionMode: "resume",
      executionMode: this.opts.executionMode,
      outputFormat: executionKind === "antigravity" || executionKind === "claude"
        ? "stream-json"
        : executionKind === "grok"
          ? "streaming-json"
          : "json",
      logFile: fallbackLogFile,
      soulContext: fallbackPromptForCli.soulContext,
      includeResponseContract: fallbackPromptForCli.includeResponseContract,
      outputDir: outDir,
      attachments,
      nativeCompletion: true,
    });
    const isFallbackClaudeStreamJson = executionKind === "claude"
      && fallbackInvocation.args.includes("stream-json");

    try {
      const fallbackCwd = this._workingDir(executionKind);
      const fallbackStartedAtMs = Date.now();
      let rawResult: string;
      try {
        rawResult = (await this.exec.runCliAsync(fallbackInvocation.command, fallbackInvocation.args, fallbackCwd, {
          ...buildExecutionOptions(executionKind),
          onProgress,
          onProviderOutputChunk: body.onProviderOutputChunk,
          chatId: this._executionLane(chatKey),
          stdin: fallbackInvocation.stdin,
          contextEnv: fallbackPromptForCli.contextEnv,
          eventContext,
          onEvent: collect ?? undefined,
        })).text;
      } finally {
        body.onProviderOutputFinished?.();
      }
      this._assertLaneOwned(laneHandle);

      let fallbackLogContent: string | null = null;
      if (fallbackLogFile) {
        try { fallbackLogContent = readFileSync(fallbackLogFile, "utf8"); } catch {}
        finally { try { rmSync(fallbackLogFile); } catch {} }
      }

      let result: CliResult;
      if (isFallbackClaudeStreamJson) {
        const parsed = parseClaudeStreamJsonOutput(rawResult);
        result = parsed ?? { text: rawResult.trim(), sessionId: null };
      } else {
        const outputFormat = executionKind === "antigravity"
          ? (fallbackInvocation.args.includes("stream-json") ? "stream-json" : (fallbackInvocation.args.includes("json") ? "json" : "text"))
          : undefined;
        result = parseCliResult({ bot: executionKind, stdout: rawResult, logContent: fallbackLogContent, outputFormat });
      }
      if (executionKind === "antigravity" && !result.sessionId) {
        result.sessionId = resolveAntigravityConversationId({ cwd: fallbackCwd, sinceMs: fallbackStartedAtMs, explicitLogContent: fallbackLogContent });
      }
      const currentModel = isAgentKind(this.kind) ? (this.db.getSetting(this.kind) || this.opts.botConfig.modelPreference[0] || null) : null;
      const finalResult = {
        ...result,
        text: `⚠️ Fell back to ${fallbackModel} (${currentModel || "default"} at capacity)\n\n${result.text}`,
      };
      const stagedResult: StagedCliResult = { ...this._stageResultState(finalResult), nativeSessionMode: "fresh" };
      this._renewLaneOrThrow(laneHandle);
      if (this.hooks.onAfterExecute) {
        await this.hooks.onAfterExecute(prompt, stagedResult.text, hookContext(chatId, chatKey, eventContext?.threadId));
      }
      return stagedResult;
    } catch (fallbackError) {
      if (fallbackLogFile) { try { rmSync(fallbackLogFile); } catch {} }
      throw fallbackError;
    }
  }

  private _handleCircuitBreaker(error: Error, chatKey: string, laneHandle: ExecutionLaneHandle): void {
    if (!isAgentKind(this.kind)) return;
    const msg = error.message ?? "";
    const silentResumedClaudeExit = this.kind === "claude"
      && this.db.getSession(chatKey, "claude") !== null
      && /^CLI exited with code 1: \(no diagnostic output\)$/.test(msg);
    if (/timeout|killed by signal/i.test(msg) || silentResumedClaudeExit) {
      this._runWithFence(laneHandle, () => {
        const failures = this.db.incrementFailures(chatKey, this.kind as BotKind);
        if (failures >= 2) {
          console.warn(`[${this.kind}] clearing session after ${failures} consecutive failures for ${chatKey}`);
          db_setSession(this.db, chatKey, this.kind as BotKind, null);
          this.db.resetFailures(chatKey, this.kind as BotKind);
        }
      });
    } else if (/No conversation found with session ID|thread not found|session not found|conversation not found/i.test(msg)) {
      console.warn(`[${this.kind}] clearing invalid session ID for ${chatKey}`);
      this._runWithFence(laneHandle, () => db_setSession(this.db, chatKey, this.kind as BotKind, null));
      this.db.resetFailures(chatKey, this.kind);
    }
  }

  async handleCallback(callbackQuery: TelegramCallbackQuery, providedChatKey?: string): Promise<void> {
    const fromId = callbackQuery?.from?.id;
    if (!this.opts.allowedUserIds.has(String(fromId))) return;
    if (!isAgentKind(this.kind) || !this.opts.fullConfig) return;

    const data = String(callbackQuery?.data || "");
    const [action, targetKind, ...rest] = data.split(":");
    if (action === "queue_mode") {
      const value = targetKind.trim();
      const chatId = callbackQuery.message?.chat?.id;
      const messageId = callbackQuery.message?.message_id;
      const chatType = callbackQuery.message?.chat?.type ?? "private";
      const threadId = callbackQuery.message?.message_thread_id;
      if (!chatId || !messageId || !["augment", "interrupt", "queue", "reset"].includes(value)) return;
      const chatKey = providedChatKey ?? topicChatKey(chatId, chatType, threadId);
      this.db.setSetting(busyMessageModeSettingKey(this.surfaceIdentity, chatKey), value === "reset" ? null : value);
      const effective = this._busyMessageMode(chatKey);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Busy-message mode: ${effective}` });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Busy-message mode: ${effective}. This applies to new messages while this lane is busy.`,
        reply_markup: buildBusyMessageModeKeyboard(effective),
      });
      await this.sendText(chatId, { text: `✓ Busy-message mode set to ${effective}`, message_thread_id: threadId });
      return;
    }
    if (!["model", "effort"].includes(action) || targetKind !== this.kind) return;

    const value = rest.join(":").trim();
    const messageId = callbackQuery.message?.message_id;
    const chatId = callbackQuery.message?.chat?.id;
    const threadId = callbackQuery.message?.message_thread_id;
    if (!chatId || !messageId) return;

    if (action === "effort") {
      const next = value === "reset" ? resolveDefaultEffort(this.kind) : value;
      if (!isEffortLevel(next)) {
        await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: "Unsupported effort" });
        return;
      }
      this.db.setSetting(effortSettingKey(this.kind), value === "reset" ? null : next);
      await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildEffortText(this.kind, next),
        reply_markup: buildEffortKeyboard(this.kind, next),
      });
      await this.sendText(chatId, { text: `✓ Effort set to ${next}`, message_thread_id: threadId });
      return;
    }

    if (value === "reset") {
      this.db.setSetting(this.kind, null);
      if (this.kind === "antigravity") setAntigravityModel(null);
      await this.client.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `${this.kind} reset to default`,
      });
      await this.client.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
        reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, null),
      });
      return;
    }

    this.db.setSetting(this.kind, value);
    if (this.kind === "antigravity") setAntigravityModel(value);
    await this.client.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await this.client.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: buildModelsText(this.kind, { db: this.db, config: this.opts.fullConfig }),
      reply_markup: buildModelKeyboard(this.kind, this.opts.botConfig.modelPreference, value),
    });
    await this.sendText(chatId, { text: `✓ Model set to ${value}`, message_thread_id: threadId });
  }

  async sendText(chatId: number | string, body: any): Promise<number | string | null> {
    return sendSurfaceMessage({ client: this.client, kind: this._deliveryKind(), chatId, body });
  }

  private _busyMessageMode(chatKey: string): BusyMessageMode {
    return resolveLaneBusyMessageMode(this.db, this.surfaceIdentity, chatKey, this.opts.busyMessageMode ?? "augment");
  }

  private _executionKind(): BotKind {
    return isAgentKind(this.kind) ? this.kind : (this.opts.executionKind ?? "claude");
  }

  private _deliveryKind(): string {
    return this._executionKind();
  }

  private _effectiveConfig(): BridgeConfig {
    if (this.opts.fullConfig) return this.opts.fullConfig;
    const kind = this.kind as BotKind;
    const emptyBot = { token: undefined, command: "", modelPreference: [] };
    return {
      allowedUserIds: this.opts.allowedUserIds,
      serviceEnvFile: null,
      serviceKind: isAgentKind(this.kind) ? kind : null,
      pollIntervalMs: this.opts.pollIntervalMs,
      executionMode: this.opts.executionMode,
      dbPath: "",
      bots: {
        codex: this.kind === "codex" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        antigravity: this.kind === "antigravity" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        claude: this.kind === "claude" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        grok: this.kind === "grok" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
        cursor: this.kind === "cursor" ? { token: undefined, command: this.opts.botConfig.command, modelPreference: this.opts.botConfig.modelPreference } : emptyBot,
      },
    };
  }
}

function db_setSession(db: BridgeDb, chatKey: string, kind: BotKind, sessionId: string | null) {
  try {
    db.setSession(chatKey, kind, sessionId);
  } catch {
    // ignore — non-agent kinds are not tracked
  }
}
