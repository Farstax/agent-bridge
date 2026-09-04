/**
 * PURPOSE: Interactive bot — single Telegram bot with switchable CLI routing.
 * Handles /switch and /cli commands; routes all other messages to the active CLI engine.
 * NEIGHBORS: src/index-interactive.ts, src/db.ts, src/engine.ts
 */

import type { BridgeDb } from "./db.js";
import type { TelegramUpdate } from "./types.js";
import { buildTelegramCommands } from "./commands.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import { markHandoffRequired } from "./handoffState.js";
import type { ExecutionOutcome, PendingMessage } from "./engine.js";
import { adaptTelegramUpdate, type InteractiveSurroundingContextMessage, type InteractiveTurnInput } from "./interactiveIngress.js";
import { surfaceCapabilities, type MessagingPlatform } from "./platform.js";
import { withPassiveSurroundingContext } from "./workspaceContext.js";

export type CliKind = "codex" | "claude" | "antigravity" | "grok" | "cursor";
export type InteractiveCommandRegistration = {
  commands: Array<{ command: string; description: string }>;
  scope?: { type: "all_group_chats" | "all_chat_administrators" } | { type: "chat" | "chat_administrators"; chat_id: number };
};

const VALID_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity", "grok", "cursor"];
const DEFAULT_CLI: CliKind = "codex";
const DEFAULT_AUTHENTICATED_CLI_KINDS = new Set<CliKind>(["codex", "claude", "antigravity"]);

export interface InteractiveUpdateLogSummary {
  updateId: number;
  kind: "message" | "callback_query" | "other";
  chatId: number | null;
  chatType: string | null;
  threadId: number | null;
  fromId: number | null;
  senderChatId: number | null;
  content: "text" | "caption" | "non_text" | null;
  contentDetail: string | null;
}

export function getUserCliPreference(db: BridgeDb, chatId: string): CliKind {
  try {
    db.raw.prepare(`ALTER TABLE bridge_state ADD COLUMN interactive_cli_preference TEXT`).run();
  } catch { /* column already exists */ }

  const row = db.raw
    .prepare(`SELECT interactive_cli_preference AS pref FROM bridge_state WHERE chat_id = ?`)
    .get(chatId) as { pref: string | null } | undefined;
  const stored = row?.pref ?? null;
  return isValidCliKind(stored) ? stored : DEFAULT_CLI;
}

export function setUserCliPreference(db: BridgeDb, chatId: string, cli: CliKind): void {
  try {
    db.raw.prepare(`ALTER TABLE bridge_state ADD COLUMN interactive_cli_preference TEXT`).run();
  } catch { /* column already exists */ }

  db.raw
    .prepare(
      `INSERT INTO bridge_state (chat_id, interactive_cli_preference) VALUES (?, ?)
       ON CONFLICT (chat_id) DO UPDATE SET interactive_cli_preference = excluded.interactive_cli_preference`
    )
    .run(chatId, cli);
}

export function handleCliSwitchCallback(data: string): CliKind | null {
  if (!data.startsWith("cli:")) return null;
  const kind = data.slice(4);
  return isValidCliKind(kind) ? kind : null;
}

export function getSelectableCliKinds(authenticated: ReadonlySet<CliKind> = DEFAULT_AUTHENTICATED_CLI_KINDS): CliKind[] {
  return VALID_CLI_KINDS.filter((kind) => authenticated.has(kind));
}

export function resolveAvailableCliPreference(
  preferred: CliKind,
  authenticated: ReadonlySet<CliKind> = DEFAULT_AUTHENTICATED_CLI_KINDS,
): CliKind | null {
  const selectable = getSelectableCliKinds(authenticated);
  if (selectable.length === 0) return null;
  return selectable.includes(preferred) ? preferred : selectable[0];
}

export function buildCliStatusText(
  activeCli: CliKind,
  authenticated: ReadonlySet<CliKind> = DEFAULT_AUTHENTICATED_CLI_KINDS,
): string {
  const selectable = getSelectableCliKinds(authenticated);
  if (selectable.length === 0) {
    return [
      "Active CLI: **none available**",
      "Available: none",
      "Switch with: no available CLI",
    ].join("\n");
  }

  const resolvedActive = selectable.includes(activeCli) ? activeCli : selectable[0];
  const others = selectable.filter((k) => k !== resolvedActive);
  return [
    `Active CLI: **${resolvedActive}**`,
    `Available: ${selectable.join(", ")}`,
    others.length > 0 ? `Switch with: /switch ${others[0]}` : "Switch with: no other available CLI",
  ].join("\n");
}

export function isCliCommandText(rawText: string, botUsername?: string | null): boolean {
  const command = rawText.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (command === "/cli") return true;
  if (!botUsername || !command?.startsWith("/cli@")) return false;
  return command.slice("/cli@".length) === botUsername.toLowerCase();
}

export function buildCliKeyboard(
  activeCli: CliKind,
  authenticated: ReadonlySet<CliKind> = DEFAULT_AUTHENTICATED_CLI_KINDS,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const selectable = getSelectableCliKinds(authenticated);
  const resolvedActive = selectable.includes(activeCli) ? activeCli : selectable[0];
  return {
    inline_keyboard: selectable.map((cli) => [{
      text: cli === resolvedActive ? `✓ ${cli}` : cli,
      callback_data: `cli:${cli}`,
    }]),
  };
}

export function buildInteractiveCommands(pref: CliKind, options: { integratedHealth?: boolean; autonomy?: boolean } = {}): Array<{ command: string; description: string }> {
  const interactiveOnly = [
    { command: "cli", description: "Show active CLI and switch with one tap" },
    ...(options.integratedHealth ? [{ command: "health", description: "Run health checks or show the latest report" }] : []),
    ...(options.autonomy ? [{ command: "autonomy", description: "Approve, inspect, or stop autonomy" }] : []),
  ];
  const cliCmds = buildTelegramCommands(pref);
  const seen = new Set(interactiveOnly.map(c => c.command));
  const merged = [...interactiveOnly];
  for (const cmd of cliCmds) {
    if (!seen.has(cmd.command)) {
      seen.add(cmd.command);
      merged.push(cmd);
    }
  }
  return merged;
}

export function buildGlobalInteractiveCommandRegistrations(pref: CliKind, options: { integratedHealth?: boolean; autonomy?: boolean } = {}): InteractiveCommandRegistration[] {
  const commands = buildInteractiveCommands(pref, options);
  return [
    { commands },
    { commands, scope: { type: "all_group_chats" } },
    { commands, scope: { type: "all_chat_administrators" } },
  ];
}

export function buildChatInteractiveCommandRegistrations(pref: CliKind, chatId: number, options: { integratedHealth?: boolean; autonomy?: boolean } = {}): InteractiveCommandRegistration[] {
  const commands = buildInteractiveCommands(pref, options);
  return [
    { commands, scope: { type: "chat", chat_id: chatId } },
    { commands, scope: { type: "chat_administrators", chat_id: chatId } },
  ];
}

export function resolveUpdateChatKey(update: TelegramUpdate): string | null {
  const msg = update.message;
  const cbqMsg = update.callback_query?.message;
  const chatId = msg?.chat?.id ?? cbqMsg?.chat?.id;
  if (chatId == null) return null;
  const source = msg ?? cbqMsg;
  const threadId = source?.message_thread_id;
  if (threadId != null) return `${chatId}:${threadId}`;
  return String(chatId);
}

export function resolveMessageThreadId(update: TelegramUpdate): number | undefined {
  return update.message?.message_thread_id ?? update.callback_query?.message?.message_thread_id;
}

export function isAuthorizedInteractiveUpdate(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>,
): boolean {
  const userId = update.message?.from?.id ?? update.callback_query?.from?.id;
  if (userId == null) return false;
  return allowedUserIds.has(String(userId));
}

export function describeInteractiveUpdateForLog(update: TelegramUpdate): InteractiveUpdateLogSummary {
  const message = update.message ?? update.callback_query?.message;
  const sender = update.message?.from ?? update.callback_query?.from;
  const contentDetail = describeMessageContentDetail(update.message);
  return {
    updateId: update.update_id,
    kind: update.message ? "message" : update.callback_query ? "callback_query" : "other",
    chatId: message?.chat?.id ?? null,
    chatType: message?.chat?.type ?? null,
    threadId: message?.message_thread_id ?? null,
    fromId: sender?.id ?? null,
    senderChatId: update.message?.sender_chat?.id ?? null,
    content: update.message?.text ? "text" : update.message?.caption ? "caption" : update.message ? "non_text" : null,
    contentDetail,
  };
}

export function isGroupInteractiveUpdate(update: TelegramUpdate): boolean {
  const chatType = update.message?.chat?.type ?? update.callback_query?.message?.chat?.type;
  return chatType === "group" || chatType === "supergroup";
}

function isValidCliKind(value: unknown): value is CliKind {
  return VALID_CLI_KINDS.includes(value as CliKind);
}

function describeMessageContentDetail(message: TelegramUpdate["message"]): string | null {
  if (!message) return null;
  if (message.text) return "text";
  if (message.caption) return "caption";

  const subtypeKeys = [
    "photo",
    "document",
    "sticker",
    "animation",
    "video",
    "voice",
    "audio",
    "video_note",
    "contact",
    "location",
    "venue",
    "poll",
    "dice",
    "new_chat_members",
    "left_chat_member",
    "pinned_message",
    "forum_topic_created",
    "forum_topic_closed",
    "forum_topic_reopened",
    "general_forum_topic_hidden",
    "general_forum_topic_unhidden",
    "migrate_to_chat_id",
    "migrate_from_chat_id",
    "successful_payment",
  ];

  const record = message as unknown as Record<string, unknown>;
  return subtypeKeys.find((key) => record[key] != null) ?? "unknown_non_text";
}

type PassiveContextClient = MessagingPlatform & {
  getSurroundingContext?: (request: { channelId: string; beforeMessageId: string; guildId?: string }) => Promise<InteractiveSurroundingContextMessage[]>;
};

export interface InteractiveDispatchEngine {
  client?: PassiveContextClient;
  handleInteractiveTurn?: (turn: InteractiveTurnInput) => Promise<void>;
  handleUpdate?: (update: TelegramUpdate) => Promise<void>;
  executeClaimedMessage(message: PendingMessage): Promise<ExecutionOutcome>;
  recoverPendingQueue?: (chatKey: string) => Promise<boolean>;
}

export interface InteractiveDispatchDeps {
  engines: Record<string, InteractiveDispatchEngine>;
  fallbackChain: ProviderFallbackChain;
  exhaustedChats: Set<string>;
  db: BridgeDb;
  notify: (msg: string) => Promise<void> | void;
  onCliSwitched?: (newCli: CliKind) => Promise<void> | void;
  legacyUpdate?: TelegramUpdate;
}

const pendingFallbackTries = new WeakMap<ProviderFallbackChain, Map<string, Set<string>>>();

function fallbackTryMap(chain: ProviderFallbackChain): Map<string, Set<string>> {
  let pending = pendingFallbackTries.get(chain);
  if (!pending) {
    pending = new Map();
    pendingFallbackTries.set(chain, pending);
  }
  return pending;
}

function markPendingFallbackResume(chain: ProviderFallbackChain, chatKey: string, tried: ReadonlySet<string>): void {
  fallbackTryMap(chain).set(chatKey, new Set(tried));
}

function consumePendingFallbackResume(chain: ProviderFallbackChain, chatKey: string): Set<string> | null {
  const pending = pendingFallbackTries.get(chain);
  const tried = pending?.get(chatKey) ?? null;
  if (!tried) return null;
  pending!.delete(chatKey);
  if (pending!.size === 0) pendingFallbackTries.delete(chain);
  return tried;
}

function clearPendingFallbackResume(chain: ProviderFallbackChain, chatKey: string): void {
  const pending = pendingFallbackTries.get(chain);
  if (!pending) return;
  pending.delete(chatKey);
  if (pending.size === 0) pendingFallbackTries.delete(chain);
}

export function clearInteractiveFallbackState(chain: ProviderFallbackChain, chatKey: string): void {
  clearPendingFallbackResume(chain, chatKey);
}

function prepareCliHandoff(db: BridgeDb, chatKey: string, targetCli: CliKind, reason: string): void {
  db.setSession(chatKey, targetCli, null);
  markHandoffRequired(db, chatKey, targetCli, reason);
}

export function applyManualCliSwitchHandoff(db: BridgeDb, chatKey: string, newCli: CliKind): void {
  db.raw.transaction(() => {
    prepareCliHandoff(db, chatKey, newCli, "manual_switch");
    setUserCliPreference(db, chatKey, newCli);
    db.setSetting(`ctx_suppress:${chatKey}`, null);
  })();
}

interface InteractiveFallbackExecution {
  chatKey: string;
  execute: (engine: InteractiveDispatchEngine) => Promise<ExecutionOutcome>;
  recoverPendingQueue: boolean;
  exhaustedOutcome: ExecutionOutcome;
}

async function dispatchInteractiveExecutionWithFallback(
  execution: InteractiveFallbackExecution,
  deps: InteractiveDispatchDeps,
  tried: Set<string>,
): Promise<ExecutionOutcome> {
  const { chatKey } = execution;
  const { engines, fallbackChain, exhaustedChats, db, notify, onCliSwitched } = deps;
  exhaustedChats.delete(chatKey);
  if (tried.size === 0) {
    const pref = getUserCliPreference(db, chatKey);
    fallbackChain.setActiveCli(chatKey, pref);
  }

  const activeCli = fallbackChain.getActiveCli(chatKey) as CliKind;
  tried.add(activeCli);
  const engine = engines[activeCli];
  if (!engine) throw new Error(`No engine configured for CLI ${activeCli}`);
  const outcome = await execution.execute(engine);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    let next: CliKind | null = null;
    for (const cli of fallbackChain.getChain()) {
      if (!tried.has(cli)) {
        next = cli as CliKind;
        break;
      }
    }
    if (next) {
      prepareCliHandoff(db, chatKey, next, `fallback_from_${activeCli}`);
      fallbackChain.setActiveCli(chatKey, next);
      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      if (onCliSwitched) await onCliSwitched(next);
      if (execution.recoverPendingQueue && engines[next].recoverPendingQueue) {
        markPendingFallbackResume(fallbackChain, chatKey, tried);
        try {
          const hasPending = await engines[next].recoverPendingQueue!(chatKey);
          if (hasPending) return "queued";
        } catch (error) {
          clearPendingFallbackResume(fallbackChain, chatKey);
          throw error;
        }
        clearPendingFallbackResume(fallbackChain, chatKey);
      }
      return dispatchInteractiveExecutionWithFallback(execution, deps, tried);
    }
    await notify("All CLIs are currently unavailable. Please try again later.");
    return execution.exhaustedOutcome;
  }

  if (tried.size > 1) setUserCliPreference(db, chatKey, activeCli);
  return outcome;
}

function dispatchClaimedInteractiveExecution(
  message: PendingMessage,
  chatKey: string,
  deps: InteractiveDispatchDeps,
  tried: Set<string>,
): Promise<ExecutionOutcome> {
  return dispatchInteractiveExecutionWithFallback({
    chatKey,
    recoverPendingQueue: false,
    exhaustedOutcome: "committed",
    execute: (engine) => engine.executeClaimedMessage(message),
  }, deps, tried);
}

function shouldLoadPassiveContext(turn: InteractiveTurnInput): boolean {
  return turn.surfaceIdentity.startsWith("discord:")
    && !turn.scheduledOccurrenceKey
    && !turn.text.trim().startsWith("/")
    && turn.surroundingContext === undefined;
}

async function loadPassiveContext(turn: InteractiveTurnInput, engine: InteractiveDispatchEngine): Promise<InteractiveTurnInput> {
  if (!shouldLoadPassiveContext(turn)) return turn;
  const client = engine.client;
  if (!client || !surfaceCapabilities(client).passiveSurroundingContext || typeof client.getSurroundingContext !== "function") return turn;
  try {
    const surroundingContext = await client.getSurroundingContext({
      channelId: String(turn.delivery.chatId),
      beforeMessageId: turn.messageId,
      ...(turn.conversationScopeId ? { guildId: turn.conversationScopeId } : {}),
    });
    return surroundingContext.length > 0 ? { ...turn, surroundingContext } : turn;
  } catch (error) {
    console.warn("[interactive] passive Discord surrounding context unavailable; continuing without it", error);
    return turn;
  }
}

export function dispatchInteractiveTurnWithFallback(
  turn: InteractiveTurnInput,
  deps: InteractiveDispatchDeps,
  tried = new Set<string>(),
  claimedMessage?: PendingMessage,
): Promise<ExecutionOutcome> {
  if (claimedMessage) {
    return dispatchClaimedInteractiveExecution(claimedMessage, turn.chatKey, deps, tried);
  }

  const chatKey = turn.chatKey;
  if (isResetTurn(turn)) clearInteractiveFallbackState(deps.fallbackChain, chatKey);
  let contextualTurnPromise: Promise<InteractiveTurnInput> | null = null;
  return dispatchInteractiveExecutionWithFallback({
    chatKey,
    recoverPendingQueue: true,
    exhaustedOutcome: "failed",
    execute: async (engine) => {
      const contextualTurn = await (contextualTurnPromise ??= loadPassiveContext(turn, engine));
      const context = contextualTurn.surroundingContext ?? [];
      await withPassiveSurroundingContext(context, async () => {
        if (deps.legacyUpdate && !engine.handleInteractiveTurn && engine.handleUpdate) {
          await engine.handleUpdate(deps.legacyUpdate);
        } else if (engine.handleInteractiveTurn) {
          await engine.handleInteractiveTurn(contextualTurn);
        } else {
          throw new Error(`interactive engine ${deps.fallbackChain.getActiveCli(chatKey)} does not accept neutral turns`);
        }
      });
      return "committed";
    },
  }, deps, tried);
}

export interface UnifiedTelegramUpdateEngine {
  readonly kind: string;
  readonly client: Pick<MessagingPlatform, "answerCallbackQuery">;
  handleUpdate(update: TelegramUpdate, chatKey?: string): Promise<void>;
}

export async function handleUnavailableCliUpdate(
  update: TelegramUpdate,
  client: Pick<MessagingPlatform, "answerCallbackQuery">,
  sendUnavailableMessage: (chatId: number | string, threadId?: number | string) => Promise<void>,
): Promise<boolean> {
  const callbackQueryId = update.callback_query?.id;
  if (callbackQueryId) {
    await client.answerCallbackQuery({
      callback_query_id: callbackQueryId,
      text: "No CLI is currently available. Authenticate or install a CLI, then run /cli again.",
    });
    return true;
  }
  const message = update.message;
  if (!message) return false;
  await sendUnavailableMessage(message.chat.id, message.message_thread_id);
  return true;
}

function providerControlTarget(update: TelegramUpdate): { action: "model" | "effort"; targetKind: CliKind } | null {
  const data = String(update.callback_query?.data ?? "");
  const [action, targetKind] = data.split(":");
  if ((action !== "model" && action !== "effort") || !isValidCliKind(targetKind)) return null;
  return { action, targetKind };
}

/** Keep Telegram controls on the engine callback path, outside conversational turns. */
export async function dispatchUnifiedTelegramUpdate(
  update: TelegramUpdate,
  chatKey: string,
  surfaceIdentity: string,
  engine: UnifiedTelegramUpdateEngine,
  dispatchMessage: (turn: InteractiveTurnInput) => Promise<void>,
): Promise<void> {
  if (update.callback_query) {
    const control = providerControlTarget(update);
    if (control && control.targetKind !== engine.kind) {
      await engine.client.answerCallbackQuery({
        callback_query_id: update.callback_query.id,
        text: `Stale ${control.action} menu: active provider is ${engine.kind}. Reopen /${control.action === "model" ? "models" : "effort"}.`,
      });
      return;
    }
    await engine.handleUpdate(update, chatKey);
    return;
  }
  const turn = adaptTelegramUpdate(update, surfaceIdentity, chatKey);
  if (turn) await dispatchMessage(turn);
}

/** Compatibility boundary for legacy Telegram callers. New surfaces pass a neutral turn. */
export function dispatchInteractiveWithFallback(
  update: TelegramUpdate,
  chatKey: string,
  deps: InteractiveDispatchDeps,
  tried = new Set<string>(),
  claimedMessage?: PendingMessage,
): Promise<ExecutionOutcome> {
  const turn = adaptTelegramUpdate(update, "telegram:interactive", chatKey);
  if (!turn) return Promise.resolve(claimedMessage ? "committed" : "failed");
  return dispatchInteractiveTurnWithFallback(turn, { ...deps, legacyUpdate: update }, tried, claimedMessage);
}

function isResetTurn(turn: InteractiveTurnInput): boolean {
  const command = turn.text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return command === "/reset" || command.startsWith("/reset@");
}

export function dispatchClaimedInteractiveWithFallback(
  message: PendingMessage,
  chatKey: string,
  deps: InteractiveDispatchDeps,
): Promise<ExecutionOutcome> {
  const resumedTries = consumePendingFallbackResume(deps.fallbackChain, chatKey);
  return dispatchClaimedInteractiveExecution(message, chatKey, deps, resumedTries ?? new Set());
}
