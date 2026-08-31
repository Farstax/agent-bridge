from pathlib import Path
import re, sys

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode not in {"tests", "implementation"}:
    raise SystemExit("usage: issue-605-transform-v2.py tests|implementation")

def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def replace(path, old, new, count=1):
    text = read(path)
    found = text.count(old)
    if found < count:
        raise RuntimeError(f"{path}: anchor not found ({found} < {count}): {old[:100]!r}")
    write(path, text.replace(old, new, count))
def replace_all(path, old, new):
    text = read(path)
    if old not in text:
        raise RuntimeError(f"{path}: anchor not found: {old[:100]!r}")
    write(path, text.replace(old, new))
def replace_between(path, start, end, new):
    text = read(path)
    a = text.find(start)
    if a < 0: raise RuntimeError(f"{path}: start not found: {start[:100]!r}")
    b = text.find(end, a)
    if b < 0: raise RuntimeError(f"{path}: end not found: {end[:100]!r}")
    write(path, text[:a] + new + text[b:])

def neutral_turn(text="hello", message_id="1"):
    return f'''{{ surfaceIdentity: "telegram:interactive", chatKey: "chat:1", actorId: "1", messageId: "{message_id}", text: "{text}", delivery: {{ chatId: 1, chatType: "private" }}, attachments: [] }}'''

if mode == "tests":
    write("test/interactiveIngress.test.ts", '''import { describe, expect, it, vi } from "vitest";
import { adaptDiscordMessage, adaptTelegramUpdate } from "../src/interactiveIngress.js";
import { DISCORD_SURFACE_CAPABILITIES, TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import { buildScheduledInteractiveTurn, type ScheduledRoutine } from "../src/scheduledRoutines.js";
import { DiscordClient } from "../src/discord.js";

function routine(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "routine-1",
    name: "Morning priorities",
    instruction: "Review current work.",
    kind: "companion",
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100:42",
    ownerKey: "owner:test",
    timezone: "Europe/London",
    schedule: { type: "weekly", weekdays: [1], time: "08:00" },
    enabled: true,
    createdAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("surface-neutral interactive ingress", () => {
  it("keeps Discord snowflakes lossless and string-valued", () => {
    const turn = adaptDiscordMessage({
      id: "123456789012345678",
      channel_id: "223456789012345678",
      guild_id: "323456789012345678",
      author: { id: "423456789012345678", username: "owner" },
      content: "hello",
    }, "discord:interactive");
    expect(turn).toMatchObject({
      surfaceIdentity: "discord:interactive",
      chatKey: "223456789012345678",
      actorId: "423456789012345678",
      messageId: "123456789012345678",
      text: "hello",
      delivery: { chatId: "223456789012345678", chatType: "supergroup" },
    });
    expect(typeof turn?.delivery.chatId).toBe("string");
  });

  it("preserves Telegram topic identity while normalizing wire types once", () => {
    const turn = adaptTelegramUpdate({
      update_id: 7,
      message: {
        message_id: 8,
        chat: { id: -100123, type: "supergroup" },
        from: { id: 42, first_name: "owner" },
        message_thread_id: 99,
        text: "hello",
      },
    }, "telegram:interactive", "-100123:99");
    expect(turn).toEqual({
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100123:99",
      actorId: "42",
      messageId: "8",
      text: "hello",
      threadId: "99",
      delivery: { chatId: -100123, chatType: "supergroup" },
      attachments: [],
    });
  });

  it("builds scheduled Telegram and Discord occurrences as the same neutral shape", () => {
    const telegram = buildScheduledInteractiveTurn(routine(), "2026-08-31T07:00:00.000Z", "123");
    expect(telegram).toMatchObject({ chatKey: "-100:42", actorId: "123", threadId: "42", delivery: { chatId: -100 } });

    const discord = buildScheduledInteractiveTurn(routine({ surfaceIdentity: "discord:interactive", chatKey: "223456789012345678" }), "2026-08-31T07:00:00.000Z", "423456789012345678");
    expect(discord).toMatchObject({ chatKey: "223456789012345678", actorId: "423456789012345678", delivery: { chatId: "223456789012345678" } });
    expect(typeof discord.delivery.chatId).toBe("string");
  });

  it("declares deterministic surface delivery capabilities and fails closed for unsupported Discord APIs", () => {
    expect(TELEGRAM_SURFACE_CAPABILITIES).toMatchObject({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, formatting: "telegram-html" });
    expect(DISCORD_SURFACE_CAPABILITIES).toMatchObject({ maxMessageLength: 1990, editMessages: true, deleteMessages: false, previewStreaming: false, threads: false, formatting: "discord-markdown" });
    const client = new DiscordClient({ token: "tok", applicationId: "app", onUpdate: vi.fn() }, vi.fn() as any);
    expect(client.capabilities.polling).toBe(false);
    expect(client.capabilities.remoteFileDownload).toBe(false);
    expect((client as any).getUpdates).toBeUndefined();
    expect((client as any).getFilePath).toBeUndefined();
    expect((client as any).downloadFile).toBeUndefined();
  });
});
''')
    raise SystemExit(0)

# platform capability contract
write("src/platform.ts", '''/** Explicit messaging-surface contract shared by runtime delivery policy and adapters. */
export type TransportRequest = Record<string, unknown>;
export type TransportResponse = any;

export type SurfaceFormattingDialect = "telegram-html" | "discord-markdown" | "plain";
export interface SurfaceCapabilities {
  maxMessageLength: number;
  editMessages: boolean;
  deleteMessages: boolean;
  previewStreaming: boolean;
  threads: boolean;
  attachments: boolean;
  typing: boolean;
  polling: boolean;
  remoteFileDownload: boolean;
  richMessages: boolean;
  formatting: SurfaceFormattingDialect;
}

export const SAFE_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 2000,
  editMessages: false,
  deleteMessages: false,
  previewStreaming: false,
  threads: false,
  attachments: false,
  typing: false,
  polling: false,
  remoteFileDownload: false,
  richMessages: false,
  formatting: "plain",
});

export const TELEGRAM_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 4096,
  editMessages: true,
  deleteMessages: true,
  previewStreaming: true,
  threads: true,
  attachments: true,
  typing: true,
  polling: true,
  remoteFileDownload: true,
  richMessages: true,
  formatting: "telegram-html",
});

export const DISCORD_SURFACE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  maxMessageLength: 1990,
  editMessages: true,
  deleteMessages: false,
  previewStreaming: false,
  threads: false,
  attachments: true,
  typing: true,
  polling: false,
  remoteFileDownload: false,
  richMessages: false,
  formatting: "discord-markdown",
});

export interface MessagingPlatform {
  readonly capabilities?: SurfaceCapabilities;
  getUpdates?(options: TransportRequest): Promise<TransportResponse>;
  sendMessage(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendRichMessageDraft?(body: TransportRequest): Promise<TransportResponse>;
  editMessageText(body: TransportRequest): Promise<TransportResponse>;
  deleteMessage?(body: TransportRequest): Promise<TransportResponse>;
  sendChatAction(body: TransportRequest): Promise<TransportResponse>;
  answerCallbackQuery(body: TransportRequest): Promise<TransportResponse>;
  setMyCommands(body: TransportRequest): Promise<TransportResponse>;
  sendDocument(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  sendDocumentBuffer?(body: { chat_id: number | string; bytes: Buffer; filename: string; mime_type?: string; caption?: string; [key: string]: any }): Promise<any>;
  sendPhoto(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void>;
  getFilePath?(fileId: string): Promise<string>;
  downloadFile?(filePath: string, destPath: string): Promise<void>;
}

export interface FileSendOptions { message_thread_id?: number | string; }

export function surfaceCapabilities(platform: MessagingPlatform): SurfaceCapabilities {
  return platform.capabilities ?? SAFE_SURFACE_CAPABILITIES;
}
''')

# neutral input shape and adapters
write("src/interactiveIngress.ts", '''import type { TelegramMessage, TelegramUpdate } from "./types.js";

export interface InteractiveAttachment {
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}
export interface InteractiveTurnInput {
  surfaceIdentity: string;
  chatKey: string;
  actorId: string;
  messageId: string;
  text: string;
  threadId?: string;
  delivery: { chatId: number | string; chatType: string };
  attachments: InteractiveAttachment[];
  mediaGroupId?: string;
}

function telegramAttachments(message: TelegramMessage): InteractiveAttachment[] {
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return [{ fileId: photo.file_id, fileName: `photo_${photo.file_id}.jpg`, mimeType: "image/jpeg", ...(photo.file_size === undefined ? {} : { fileSize: photo.file_size }) }];
  }
  if (message.document) {
    const document = message.document;
    return [{ fileId: document.file_id, fileName: document.file_name ?? `document_${document.file_id}`, ...(document.mime_type ? { mimeType: document.mime_type } : {}), ...(document.file_size === undefined ? {} : { fileSize: document.file_size }) }];
  }
  return [];
}

export function adaptTelegramUpdate(update: TelegramUpdate, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  const message = update.message;
  if (!message?.chat || !message.from) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId: String(message.from.id),
    messageId: String(message.message_id),
    text: String(message.text ?? message.caption ?? "").trim(),
    ...(message.message_thread_id === undefined ? {} : { threadId: String(message.message_thread_id) }),
    delivery: { chatId: message.chat.id, chatType: message.chat.type ?? "private" },
    attachments: telegramAttachments(message),
    ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
  };
}

export function adaptDiscordMessage(data: any, surfaceIdentity = "discord:interactive"): InteractiveTurnInput | null {
  const chatKey = String(data?.channel_id ?? "");
  const actorId = String(data?.author?.id ?? "");
  const messageId = String(data?.id ?? "");
  const text = String(data?.content ?? "").trim();
  if (!chatKey || !actorId || !messageId || !text) return null;
  return { surfaceIdentity, chatKey, actorId, messageId, text, delivery: { chatId: chatKey, chatType: data?.guild_id ? "supergroup" : "private" }, attachments: [] };
}

type FlushFn = (groupId: string | null, turns: InteractiveTurnInput[]) => void | Promise<void>;
interface BufferEntry { timer?: NodeJS.Timeout; turns: InteractiveTurnInput[]; flushing: boolean; resolves: Array<() => void>; }
export class InteractiveTurnBuffer {
  private readonly groups = new Map<string, BufferEntry>();
  constructor(private readonly onFlush: FlushFn, private readonly timeoutMs = 1500) {}
  push(turn: InteractiveTurnInput): Promise<void> {
    if (!turn.mediaGroupId) return Promise.resolve(this.onFlush(null, [turn])).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error));
    const key = `${turn.surfaceIdentity}:${turn.chatKey}:${turn.mediaGroupId}`;
    let entry = this.groups.get(key);
    if (entry && !entry.flushing) clearTimeout(entry.timer);
    else { entry = { turns: [], flushing: false, resolves: [] }; this.groups.set(key, entry); }
    entry.turns.push(turn);
    const pending = new Promise<void>((resolve) => entry!.resolves.push(resolve));
    entry.timer = setTimeout(() => {
      entry!.flushing = true;
      const turns = [...entry!.turns];
      const resolves = [...entry!.resolves];
      this.groups.delete(key);
      Promise.resolve(this.onFlush(turn.mediaGroupId!, turns)).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error)).finally(() => resolves.forEach((resolve) => resolve()));
    }, this.timeoutMs);
    return pending;
  }
}
''')

# clients declare concrete capabilities; Discord stops pretending to implement Telegram-only APIs
replace("src/telegram.ts", 'import type { FileSendOptions, MessagingPlatform } from "./platform.js";', 'import { TELEGRAM_SURFACE_CAPABILITIES, type FileSendOptions, type MessagingPlatform } from "./platform.js";')
replace("src/telegram.ts", 'export class TelegramClient implements MessagingPlatform {', 'export class TelegramClient implements MessagingPlatform {\n  readonly capabilities = TELEGRAM_SURFACE_CAPABILITIES;')
replace("src/discord.ts", 'import type { MessagingPlatform } from "./platform.js";', 'import { DISCORD_SURFACE_CAPABILITIES, type MessagingPlatform } from "./platform.js";')
replace("src/discord.ts", 'export class DiscordClient implements MessagingPlatform {', 'export class DiscordClient implements MessagingPlatform {\n  readonly capabilities = DISCORD_SURFACE_CAPABILITIES;')
replace_between("src/discord.ts", '  /**\n   * getFilePath / downloadFile are Telegram-specific attachment APIs.', '  // ── Private REST helpers', '  // ── Private REST helpers')

# generic attachment download after ingress normalization
replace("src/fileDownload.ts", 'import type { MessagingPlatform } from "./platform.js";', 'import { surfaceCapabilities, type MessagingPlatform } from "./platform.js";\nimport type { InteractiveAttachment } from "./interactiveIngress.js";')
insert_anchor = 'export async function downloadTelegramAttachment('
text = read("src/fileDownload.ts")
pos = text.find(insert_anchor)
if pos < 0: raise RuntimeError("src/fileDownload.ts: insert anchor missing")
generic_download = '''export async function downloadSurfaceAttachment(
  client: MessagingPlatform,
  attachment: InteractiveAttachment,
  destDir: string,
  fileNamePrefix = "",
): Promise<AttachmentInfo | null> {
  const capabilities = surfaceCapabilities(client);
  if (!capabilities.remoteFileDownload || !client.getFilePath || !client.downloadFile) return null;
  await mkdir(destDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(destDir, PRIVATE_DIR_MODE);
  if (attachment.fileSize !== undefined && attachment.fileSize > MAX_FILE_SIZE) return null;
  const localPath = resolveContainedUploadPath(destDir, `${fileNamePrefix}${attachment.fileName}`);
  if (!localPath) return null;
  try {
    const filePath = await client.getFilePath(attachment.fileId);
    await client.downloadFile(filePath, localPath);
    return { localPath, mimeType: attachment.mimeType ?? mimeTypeFromExtension(attachment.fileName) };
  } catch { return null; }
}

'''
write("src/fileDownload.ts", text[:pos] + generic_download + text[pos:])

# scheduled occurrences build the neutral input directly
replace("src/scheduledRoutines.ts", 'import type { TelegramUpdate } from "./types.js";', 'import type { InteractiveTurnInput } from "./interactiveIngress.js";')
replace_between("src/scheduledRoutines.ts", 'export function buildScheduledInteractiveUpdate(', '\n}', '''export function buildScheduledInteractiveTurn(
  routine: ScheduledRoutine,
  intendedAt: string,
  authorizedUserId: string,
): InteractiveTurnInput {
  const syntheticId = deterministicSyntheticId(routine.id, intendedAt);
  const text = [
    `[Scheduled routine: ${routine.name}]`,
    `This instruction was explicitly authorised earlier and was scheduled for ${intendedAt}.`,
    "Carry out the stored instruction now using the current conversation context.",
    "Do not create, edit, disable, or delete scheduled routines from this triggered Run.",
    "",
    routine.instruction,
  ].join("\\n");
  const messageId = `scheduled:${routine.id}:${intendedAt}:${syntheticId}`;

  if (routine.surfaceIdentity.startsWith("telegram:")) {
    const destination = scheduledTelegramDestination(routine);
    if (!/^-?\\d+$/.test(authorizedUserId)) throw new Error("scheduled Telegram routine has invalid authorised user");
    return {
      surfaceIdentity: routine.surfaceIdentity,
      chatKey: routine.chatKey,
      actorId: authorizedUserId,
      messageId,
      text,
      ...(destination.threadId === undefined ? {} : { threadId: String(destination.threadId) }),
      delivery: { chatId: destination.chatId, chatType: destination.chatId < 0 ? "supergroup" : "private" },
      attachments: [],
    };
  }
  if (routine.surfaceIdentity.startsWith("discord:")) {
    return { surfaceIdentity: routine.surfaceIdentity, chatKey: routine.chatKey, actorId: authorizedUserId, messageId, text, delivery: { chatId: routine.chatKey, chatType: "private" }, attachments: [] };
  }
  throw new Error(`unsupported scheduled routine surface: ${routine.surfaceIdentity}`);
}''')

# Discord /start becomes a neutral adapter instead of a Telegram impersonation
write("src/discordStart.ts", '''import { parseStartPayload } from "./commands.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";

export type DiscordStartResolution = { kind: "accepted"; turn: InteractiveTurnInput } | { kind: "rejected"; reason: "invalid_payload" };
export function resolveDiscordStartInteraction(
  interaction: any,
  context: { surfaceIdentity: string; chatKey: string; userId: string; username?: string; chatType?: "private" | "supergroup" },
): DiscordStartResolution {
  if (interaction?.type !== 2 || interaction?.data?.name !== "start") return { kind: "rejected", reason: "invalid_payload" };
  const options = interaction?.data?.options;
  const payloadOptions = Array.isArray(options) ? options.filter((option: any) => option?.name === "payload") : [];
  if (payloadOptions.length > 1) return { kind: "rejected", reason: "invalid_payload" };
  const payloadOption = payloadOptions[0];
  const rawPayload = payloadOption?.value;
  const hasPayload = payloadOption !== undefined;
  const text = !hasPayload ? "/start" : typeof rawPayload === "string" ? `/start ${rawPayload}` : "";
  if (!text || (hasPayload && !parseStartPayload(text))) return { kind: "rejected", reason: "invalid_payload" };
  const messageId = String(interaction?.id ?? "");
  if (!messageId) return { kind: "rejected", reason: "invalid_payload" };
  return { kind: "accepted", turn: { surfaceIdentity: context.surfaceIdentity, chatKey: context.chatKey, actorId: context.userId, messageId, text, delivery: { chatId: context.chatKey, chatType: context.chatType ?? "private" }, attachments: [] } };
}
''')

# engine: adapt Telegram once, then use neutral turn fields for shared command/admission execution
replace("src/engine.ts", 'import { TelegramClient, MediaGroupBuffer } from "./telegram.js";', 'import { TelegramClient } from "./telegram.js";')
replace("src/engine.ts", 'import { downloadTelegramAttachment } from "./fileDownload.js";', 'import { downloadSurfaceAttachment } from "./fileDownload.js";')
replace("src/engine.ts", 'import { sendTelegramMessage, sendMessageWithProgress, PreviewCleanupError } from "./messageDelivery.js";', 'import { sendSurfaceMessage, sendMessageWithProgress, PreviewCleanupError } from "./messageDelivery.js";')
# tolerate alternate import order
if 'sendTelegramMessage' in read("src/engine.ts"):
    replace("src/engine.ts", 'import { PreviewCleanupError, sendTelegramMessage, sendMessageWithProgress } from "./messageDelivery.js";', 'import { PreviewCleanupError, sendSurfaceMessage, sendMessageWithProgress } from "./messageDelivery.js";')
replace("src/engine.ts", 'import { buildModelKeyboard, buildModelsText, getCliWorkingDir, extractPromptText, extractThreadId, isAuthorizedMessage } from "./bridge.js";', 'import { buildModelKeyboard, buildModelsText, getCliWorkingDir } from "./bridge.js";')
# exact types import can include TelegramMessage; remove it if present
text = read("src/engine.ts").replace(', TelegramMessage', '').replace('TelegramMessage, ', '')
# add neutral import after types import block via stable import
needle = 'import type { MessagingPlatform } from "./platform.js";'
if needle in text:
    text = text.replace(needle, needle + '\nimport { adaptTelegramUpdate, InteractiveTurnBuffer, type InteractiveTurnInput } from "./interactiveIngress.js";', 1)
else:
    raise RuntimeError("engine platform import missing")
write("src/engine.ts", text)
replace("src/engine.ts", '  readonly mediaBuffer: MediaGroupBuffer;', '  readonly mediaBuffer: InteractiveTurnBuffer;')
# remove weakmap and rename dedupe set
replace("src/engine.ts", '  private readonly seenTelegramMessageKeys = new Set<string>();\n  private readonly messageChatKeys = new WeakMap<TelegramMessage, string>();', '  private readonly seenInteractiveMessageKeys = new Set<string>();')
replace_between("src/engine.ts", '    this.mediaBuffer = new MediaGroupBuffer({', '    });', '''    this.mediaBuffer = new InteractiveTurnBuffer((_groupId, turns) => {
      return this.handleInteractiveMessages(turns).catch((err) => {
        console.error(`[${this.kind}] mediaBuffer flush error`, err);
      });
    }, 1500);''')

new_ingress_methods = '''  async handleUpdate(update: TelegramUpdate, providedChatKey?: string): Promise<void> {
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
      executionOutcome = await this._executeAndSend(prompt!, chatId, chatKey, primaryMessage.delivery.chatType, threadId, userId, hookCtx, attachments, attachmentLocalPath, null, true, true, !finalDeliveryActive, ownsAugmentedTask);
    } finally {
      const transferred = this.laneCoordinator.isAugmentTransferred(executionLane);
      const retainedByCancellation = this.laneCoordinator.hasCancellation(executionLane);
      if (executionOutcome !== "queued" && !transferred && !retainedByCancellation) { try { rmSync(uploadDir, { recursive: true, force: true }); } catch {} }
      if (transferred) this.laneCoordinator.clearAugmentTransferred(executionLane);
      if (ownsAugmentedTask && !retainedByCancellation && !transferred) this.laneCoordinator.clearAugmentedTask(executionLane);
    }
  }

'''
replace_between("src/engine.ts", '  async handleUpdate(update: TelegramUpdate, providedChatKey?: string): Promise<void> {', '  private async _executeBtw', new_ingress_methods)

# widen native delivery coordinates only; durable identity remains chatKey + surfaceIdentity
text = read("src/engine.ts")
text = re.sub(r'chatId: number(?! \| string)', 'chatId: number | string', text)
text = re.sub(r'threadId: number(?! \| string)', 'threadId: number | string', text)
text = re.sub(r'userId: number(?! \| string)', 'userId: number | string', text)
text = text.replace('sendTelegramMessage({', 'sendSurfaceMessage({')
# generic hook context should not coerce transport ids
text = re.sub(r'function hookContext\([\s\S]*?\n\}', '''function hookContext(chatId: number | string, chatKey: string, threadId?: number | string): HookContext {
  return { chatId, chatKey, threadId };
}''', text, count=1)
write("src/engine.ts", text)

# pending queue metadata supports lossless string transport ids; SQLite schema/identity is unchanged
for old, new in [
    ('chatId: number; threadId: number | null; chatType: string; userId: number | null;', 'chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null;'),
    ('chatId: number; threadId?: number; chatType: string; userId?: number;', 'chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string;'),
]:
    text = read("src/db.ts")
    if old in text: write("src/db.ts", text.replace(old, new))

# output delivery accepts native string channel ids
replace_all("src/fileOutput.ts", '  chatId: number,', '  chatId: number | string,')

# shared fallback dispatch consumes neutral turns only
replace("src/interactiveBot.ts", 'import type { ExecutionOutcome, PendingMessage } from "./engine.js";', 'import type { ExecutionOutcome, PendingMessage } from "./engine.js";\nimport type { InteractiveTurnInput } from "./interactiveIngress.js";')
replace("src/interactiveBot.ts", 'export interface InteractiveDispatchEngine {\n  handleUpdate(update: TelegramUpdate, chatKey?: string): Promise<void>;', 'export interface InteractiveDispatchEngine {\n  handleInteractiveTurn(turn: InteractiveTurnInput): Promise<void>;')
new_dispatch = '''export async function dispatchInteractiveTurnWithFallback(
  turn: InteractiveTurnInput,
  deps: InteractiveDispatchDeps,
  tried = new Set<string>(),
  claimedMessage?: PendingMessage,
): Promise<ExecutionOutcome> {
  const chatKey = turn.chatKey;
  const { engines, fallbackChain, exhaustedChats, db, notify, onCliSwitched } = deps;
  exhaustedChats.delete(chatKey);
  if (!claimedMessage && isResetTurn(turn)) clearInteractiveFallbackState(fallbackChain, chatKey);
  if (tried.size === 0) { const pref = getUserCliPreference(db, chatKey); fallbackChain.setActiveCli(chatKey, pref); }
  const activeCli = fallbackChain.getActiveCli(chatKey) as CliKind;
  tried.add(activeCli);
  let outcome: ExecutionOutcome = "committed";
  if (claimedMessage) outcome = await engines[activeCli].executeClaimedMessage(claimedMessage);
  else await engines[activeCli].handleInteractiveTurn(turn);

  if (exhaustedChats.has(chatKey)) {
    exhaustedChats.delete(chatKey);
    let next: CliKind | null = null;
    for (const cli of fallbackChain.getChain()) if (!tried.has(cli)) { next = cli as CliKind; break; }
    if (next) {
      prepareCliHandoff(db, chatKey, next, `fallback_from_${activeCli}`);
      fallbackChain.setActiveCli(chatKey, next);
      await notify(`Switching to ${next} (${activeCli} at capacity)`);
      if (onCliSwitched) await onCliSwitched(next);
      if (!claimedMessage && engines[next].recoverPendingQueue) {
        markPendingFallbackResume(fallbackChain, chatKey, tried);
        try { const hasPending = await engines[next].recoverPendingQueue!(chatKey); if (hasPending) return "queued"; }
        catch (error) { clearPendingFallbackResume(fallbackChain, chatKey); throw error; }
        clearPendingFallbackResume(fallbackChain, chatKey);
      }
      return dispatchInteractiveTurnWithFallback(turn, deps, tried, claimedMessage);
    }
    await notify("All CLIs are currently unavailable. Please try again later.");
    return claimedMessage ? "committed" : "failed";
  }
  if (tried.size > 1) setUserCliPreference(db, chatKey, activeCli);
  return outcome;
}

function isResetTurn(turn: InteractiveTurnInput): boolean {
  const command = turn.text.trim().split(/\\s+/, 1)[0]?.toLowerCase() ?? "";
  return command === "/reset" || command.startsWith("/reset@");
}

export function dispatchClaimedInteractiveWithFallback(
  message: PendingMessage,
  chatKey: string,
  deps: InteractiveDispatchDeps,
): Promise<ExecutionOutcome> {
  const resumedTries = consumePendingFallbackResume(deps.fallbackChain, chatKey);
  const turn: InteractiveTurnInput = {
    surfaceIdentity: message.laneHandle?.surface ?? "queue",
    chatKey,
    actorId: String(message.userId ?? "queue"),
    messageId: `pending:${message.id}`,
    text: message.prompt,
    ...(message.threadId == null ? {} : { threadId: String(message.threadId) }),
    delivery: { chatId: message.chatId, chatType: message.chatType },
    attachments: [],
  };
  return dispatchInteractiveTurnWithFallback(turn, deps, resumedTries ?? new Set(), message);
}
'''
replace_between("src/interactiveBot.ts", 'export async function dispatchInteractiveWithFallback(', '\n}', new_dispatch)
# replace_between only removed first function, so strip any trailing old claimed dispatcher if still present
text = read("src/interactiveBot.ts")
old_claim = text.find('export function dispatchClaimedInteractiveWithFallback(', text.find(new_dispatch[:50]) + len(new_dispatch))
if old_claim >= 0:
    # remove to EOF closing function (it is last function in file)
    text = text[:old_claim].rstrip() + '\n'
write("src/interactiveBot.ts", text)

# Discord entrypoint: no Telegram types or numeric Snowflake aliases
replace("src/index-discord-interactive.ts", '  dispatchInteractiveWithFallback,', '  dispatchInteractiveTurnWithFallback,')
replace("src/index-discord-interactive.ts", 'import type { BridgeConfig, BotKind, TelegramUpdate, TelegramMessage } from "./types.js";', 'import type { BridgeConfig, BotKind } from "./types.js";\nimport { adaptDiscordMessage, type InteractiveTurnInput } from "./interactiveIngress.js";')
replace("src/index-discord-interactive.ts", 'import { ScheduledRoutineRunner, buildScheduledInteractiveUpdate } from "./scheduledRoutines.js";', 'import { ScheduledRoutineRunner, buildScheduledInteractiveTurn } from "./scheduledRoutines.js";')
replace("src/index-discord-interactive.ts", '    // pending_messages keeps legacy numeric delivery columns; the durable chatKey\n    // is authoritative, so restart recovery restores the native Discord destination.\n    const deliveryQueued = { ...queued, chatId: queued.chatKey as unknown as number };\n    return dispatchClaimedInteractiveWithFallback(deliveryQueued, deliveryQueued.chatKey, {', '    return dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {')
replace_all("src/index-discord-interactive.ts", 'deliveryQueued.chatKey', 'queued.chatKey')
replace("src/index-discord-interactive.ts", '      const update = buildScheduledInteractiveUpdate(routine, intendedAt, scheduledActorId);\n      await dispatchInteractiveWithFallback(update, routine.chatKey, {', '      const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId);\n      await dispatchInteractiveTurnWithFallback(turn, {')
# ordinary Discord message fake update block
start = '  const chatId = channelId as unknown as number;'
end = '  await dispatchInteractiveWithFallback(update, chatKey, {'
text = read("src/index-discord-interactive.ts")
a=text.find(start); b=text.find(end,a)
if a<0 or b<0: raise RuntimeError("Discord message fake-update block not found")
b += len(end)
replacement = '  const turn = adaptDiscordMessage(d, "discord:interactive");\n  if (!turn) return;\n\n  await dispatchInteractiveTurnWithFallback(turn, {'
write("src/index-discord-interactive.ts", text[:a]+replacement+text[b:])
# /start neutral resolution
replace("src/index-discord-interactive.ts", '      const chatId = channelId as unknown as number;\n      const numUserId = userId as unknown as number;\n      const resolution = resolveDiscordStartInteraction(d, {\n        chatId,\n        userId: numUserId,', '      const resolution = resolveDiscordStartInteraction(d, {\n        surfaceIdentity: "discord:interactive",\n        chatKey: channelId,\n        userId,')
replace("src/index-discord-interactive.ts", '      await engines[getUserCliPreference(db, channelId)].handleUpdate(resolution.update, channelId);', '      await engines[getUserCliPreference(db, channelId)].handleInteractiveTurn(resolution.turn);')
# slash fake TelegramUpdate block
text = read("src/index-discord-interactive.ts")
start = '    const promptText = d.data?.options?.[0]?.value as string | undefined ?? commandName;'
a=text.find(start)
end='    if (commandName === "reset") clearInteractiveFallbackState(fallbackChain, chatKey);'
b=text.find(end,a)
if a<0 or b<0: raise RuntimeError("Discord slash fake-update block not found")
replacement = '''    const promptText = d.data?.options?.[0]?.value as string | undefined ?? commandName;
    const chatKey = channelId;
    const turn: InteractiveTurnInput = {
      surfaceIdentity: "discord:interactive",
      chatKey,
      actorId: userId,
      messageId: String(d.id ?? ""),
      text: `/${promptText}`,
      delivery: { chatId: channelId, chatType: d.guild_id ? "supergroup" : "private" },
      attachments: [],
    };

'''
text = text[:a]+replacement+text[b:]
text = text.replace('    await engines[getUserCliPreference(db, chatKey)].handleUpdate(update, chatKey);', '    await engines[getUserCliPreference(db, chatKey)].handleInteractiveTurn(turn);')
# remove numericId utility
text = re.sub(r'\nfunction numericId\(snowflake: string\): number \{[\s\S]*?\n\}', '', text, count=1)
write("src/index-discord-interactive.ts", text)

# Telegram entrypoint adapts at its native boundary and schedules through the same neutral path
replace("src/index-interactive.ts", '  dispatchInteractiveWithFallback,', '  dispatchInteractiveTurnWithFallback,')
replace("src/index-interactive.ts", '  buildScheduledInteractiveUpdate,', '  buildScheduledInteractiveTurn,')
# add ingress import
replace("src/index-interactive.ts", 'import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";', 'import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";\nimport { adaptTelegramUpdate } from "./interactiveIngress.js";')
replace("src/index-interactive.ts", '    const update = buildScheduledInteractiveUpdate(routine, intendedAt, scheduledActorId);\n    await dispatchInteractiveWithFallback(update, routine.chatKey, {', '    const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId);\n    await dispatchInteractiveTurnWithFallback(turn, {')
old = '            dispatchInteractiveWithFallback(typedUpdate, chatKey, {'
new = '            const turn = adaptTelegramUpdate(typedUpdate, runtimePolicy.surfaceIdentity, chatKey);\n            if (!turn) continue;\n            dispatchInteractiveTurnWithFallback(turn, {'
replace("src/index-interactive.ts", old, new)

# capability-driven shared delivery; Telegram renderer remains Telegram-owned
replace("src/messageDelivery.ts", 'import type { MessagingPlatform } from "./platform.js";', 'import { surfaceCapabilities, type MessagingPlatform } from "./platform.js";')
# insert surface delivery after Telegram policy helper
anchor='async function sendEntityMessages({'
text=read("src/messageDelivery.ts"); p=text.find(anchor)
if p<0: raise RuntimeError("messageDelivery insert anchor missing")
surface_fn='''export async function sendSurfaceMessage({ client, kind, chatId, body }: { client: MessagingPlatform; kind: string; chatId: number | string; body: any }): Promise<number | string | null> {
  const capabilities = surfaceCapabilities(client);
  if (capabilities.formatting === "telegram-html") {
    const numericChatId = typeof chatId === "number" ? chatId : Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) throw new Error("Telegram delivery requires a numeric chat id");
    return sendTelegramMessage({ client, kind, chatId: numericChatId, body });
  }
  const response = await client.sendMessage({ chat_id: chatId, ...body });
  return response?.result?.message_id ?? response?.id ?? null;
}

'''
write("src/messageDelivery.ts", text[:p]+surface_fn+text[p:])
# widen shared progress chat id and use caps
text=read("src/messageDelivery.ts")
# only all chatId annotations in this module are safe to widen
text=re.sub(r'chatId: number(?! \| string)', 'chatId: number | string', text)
needle='  const { text: _ignored, ...rest } = body;\n\n  const sendTyping = async () => {'
if needle not in text: raise RuntimeError("messageDelivery capability anchor missing")
text=text.replace(needle, '  const { text: _ignored, ...rest } = body;\n  const capabilities = surfaceCapabilities(client);\n\n  const sendTyping = async () => {',1)
text=text.replace('    if (isAborted?.()) return;\n    try {\n      await client.sendChatAction({ chat_id: chatId, ...rest, action: "typing" });', '    if (isAborted?.() || !capabilities.typing) return;\n    try {\n      await client.sendChatAction({ chat_id: chatId, ...rest, action: "typing" });',1)
text=text.replace('  let answerPreviewEnabled = (kind === "claude" || kind === "antigravity")\n    && typeof client.deleteMessage === "function";', '  let answerPreviewEnabled = (kind === "claude" || kind === "antigravity")\n    && capabilities.previewStreaming && capabilities.editMessages && capabilities.deleteMessages\n    && typeof client.deleteMessage === "function";')
text=text.replace('    const bounded = text.length > MAX_TELEGRAM_TEXT\n      ? `${text.slice(0, MAX_TELEGRAM_TEXT - 1)}…`\n      : text;\n    try {\n      return { text: renderTelegramHtml(bounded), parse_mode: "HTML" };\n    } catch {\n      return { text: bounded };\n    }', '    const maxLength = capabilities.maxMessageLength;\n    const bounded = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;\n    if (capabilities.formatting !== "telegram-html") return { text: bounded };\n    try { return { text: renderTelegramHtml(bounded), parse_mode: "HTML" }; } catch { return { text: bounded }; }')
text=text.replace('      && text.length <= MAX_TELEGRAM_TEXT', '      && capabilities.editMessages\n      && text.length <= capabilities.maxMessageLength')
text=text.replace('    if (streamingEnabled && progressMsgId != null) {', '    if (streamingEnabled && capabilities.editMessages && progressMsgId != null) {')
# only final fallback in sendMessageWithProgress; global replace is desired for shared function but preserve Telegram policy calls above
last = text.rfind('await sendTelegramMessage({ client, kind, chatId, body: { ...body, text } });')
if last < 0: raise RuntimeError("messageDelivery final Telegram call missing")
text = text[:last] + 'await sendSurfaceMessage({ client, kind, chatId, body: { ...body, text } });' + text[last+len('await sendTelegramMessage({ client, kind, chatId, body: { ...body, text } });'):]
write("src/messageDelivery.ts", text)

# tests: make existing Telegram progress mocks explicitly Telegram-capable
replace("test/messageDelivery.test.ts", 'import type { TelegramClient } from "../src/telegram.js";', 'import type { TelegramClient } from "../src/telegram.js";\nimport { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";')
replace("test/messageDelivery.test.ts", 'const createMockClient = () => ({\n  sendMessage:', 'const createMockClient = () => ({\n  capabilities: TELEGRAM_SURFACE_CAPABILITIES,\n  sendMessage:')

# existing scheduled tests assert the new neutral contract rather than fake Telegram objects
replace("test/scheduledRoutines.test.ts", 'import { dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";', 'import { dispatchInteractiveTurnWithFallback, setUserCliPreference } from "../src/interactiveBot.js";')
replace("test/scheduledRoutines.test.ts", '  buildScheduledInteractiveUpdate,', '  buildScheduledInteractiveTurn,')
replace("test/scheduledRoutines.test.ts", '    const update = buildScheduledInteractiveUpdate(routine, occurrence, "123");\n    expect(update.message?.chat.id).toBe(-100);\n    expect(update.message?.chat.type).toBe("supergroup");\n    expect(update.message?.message_thread_id).toBe(42);\n    expect(update.message?.from?.id).toBe(123);\n    expect(update.message?.text).toContain(routine.instruction);', '    const turn = buildScheduledInteractiveTurn(routine, occurrence, "123");\n    expect(turn.delivery).toEqual({ chatId: -100, chatType: "supergroup" });\n    expect(turn.threadId).toBe("42");\n    expect(turn.actorId).toBe("123");\n    expect(turn.text).toContain(routine.instruction);')
replace("test/scheduledRoutines.test.ts", '    await dispatchInteractiveWithFallback(update, routine.chatKey, {', '    await dispatchInteractiveTurnWithFallback(turn, {')
replace("test/scheduledRoutines.test.ts", '          handleUpdate: async (_u, chatKey) => { observedChatKey = chatKey ?? null; },', '          handleInteractiveTurn: async (input) => { observedChatKey = input.chatKey; },')
replace("test/scheduledRoutines.test.ts", '    const update = buildScheduledInteractiveUpdate(routine, "2026-08-31T06:00:00.000Z", actor);\n    expect(String(update.message?.chat.id)).toBe(routine.chatKey);\n    expect(String(update.message?.from?.id)).toBe(actor);', '    const turn = buildScheduledInteractiveTurn(routine, "2026-08-31T06:00:00.000Z", actor);\n    expect(turn.delivery.chatId).toBe(routine.chatKey);\n    expect(turn.actorId).toBe(actor);\n    expect(typeof turn.delivery.chatId).toBe("string");')

# fallback tests use the new shared neutral dispatcher
text=read("test/interactiveBot.test.ts")
text=text.replace('  dispatchInteractiveWithFallback,', '  dispatchInteractiveTurnWithFallback,')
text=text.replace('handleUpdate', 'handleInteractiveTurn')
old1='dispatchInteractiveWithFallback({ update_id: 1, message: { text: "hello", chat: { id: 1 } } } as any, "chat:1", deps())'
text=text.replace(old1, f'dispatchInteractiveTurnWithFallback({neutral_turn()}, deps())')
old2='dispatchInteractiveWithFallback({ update_id: 2, message: { text: "next", chat: { id: 1 } } } as any, "chat:1", deps())'
text=text.replace(old2, f'dispatchInteractiveTurnWithFallback({neutral_turn("next", "2")}, deps())')
if 'dispatchInteractiveWithFallback(' in text: raise RuntimeError("interactiveBot test still contains old dispatcher")
write("test/interactiveBot.test.ts", text)

print("issue 605 v2 transform complete")
