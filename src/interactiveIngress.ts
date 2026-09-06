import type { TelegramMessage, TelegramUpdate } from "./types.js";

export interface InteractiveAttachment {
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  kind?: "audio";
  durationSeconds?: number;
  remoteUrl?: string;
}

export interface InteractiveSurroundingContextMessage {
  actorId: string;
  actorLabel: string;
  messageId: string;
  text: string;
}

export interface InteractiveTurnInput {
  surfaceIdentity: string;
  chatKey: string;
  actorId: string;
  messageId: string;
  text: string;
  /** Optional parent scope such as a Discord guild; never used as authority. */
  conversationScopeId?: string;
  threadId?: string;
  delivery: { chatId: number | string; chatType: string };
  attachments: InteractiveAttachment[];
  mediaGroupId?: string;
  /** Passive, read-only evidence from the same immediate surface conversation. */
  surroundingContext?: InteractiveSurroundingContextMessage[];
  /** Internal authoritative correlation for a previously claimed scheduled occurrence. */
  scheduledOccurrenceKey?: string;
}

function safeAttachmentName(value: unknown, fallback: string): string {
  const candidate = String(value ?? "").trim();
  if (!candidate || candidate.includes("\0") || candidate.includes("/") || candidate.includes("\\")) return fallback;
  return candidate;
}

function telegramAttachments(message: TelegramMessage): InteractiveAttachment[] {
  const raw = message as any;
  if (raw.voice?.file_id) {
    return [{
      fileId: String(raw.voice.file_id),
      fileName: `voice_${String(raw.voice.file_id)}.ogg`,
      mimeType: String(raw.voice.mime_type || "audio/ogg"),
      ...(raw.voice.file_size === undefined ? {} : { fileSize: Number(raw.voice.file_size) }),
      ...(raw.voice.duration === undefined ? {} : { durationSeconds: Number(raw.voice.duration) }),
      kind: "audio",
    }];
  }
  if (raw.audio?.file_id) {
    return [{
      fileId: String(raw.audio.file_id),
      fileName: safeAttachmentName(raw.audio.file_name, `audio_${String(raw.audio.file_id)}`),
      ...(raw.audio.mime_type ? { mimeType: String(raw.audio.mime_type) } : {}),
      ...(raw.audio.file_size === undefined ? {} : { fileSize: Number(raw.audio.file_size) }),
      ...(raw.audio.duration === undefined ? {} : { durationSeconds: Number(raw.audio.duration) }),
      kind: "audio",
    }];
  }
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return [{ fileId: photo.file_id, fileName: `photo_${photo.file_id}.jpg`, mimeType: "image/jpeg", ...(photo.file_size === undefined ? {} : { fileSize: photo.file_size }) }];
  }
  if (message.document) {
    const document = message.document;
    return [{ fileId: document.file_id, fileName: safeAttachmentName(document.file_name, `document_${document.file_id}`), ...(document.mime_type ? { mimeType: document.mime_type } : {}), ...(document.file_size === undefined ? {} : { fileSize: document.file_size }) }];
  }
  return [];
}

export function adaptTelegramMessage(message: TelegramMessage, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  if (!message.chat || !message.from) return null;
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

export function adaptTelegramUpdate(update: TelegramUpdate, surfaceIdentity: string, chatKey: string): InteractiveTurnInput | null {
  const message = update.message;
  return message ? adaptTelegramMessage(message, surfaceIdentity, chatKey) : null;
}

function discordAttachments(data: any): InteractiveAttachment[] {
  if (!Array.isArray(data?.attachments)) return [];
  return data.attachments.flatMap((raw: any, index: number) => {
    const fileId = String(raw?.id ?? "");
    const remoteUrl = String(raw?.url ?? raw?.proxy_url ?? "");
    const fileName = safeAttachmentName(raw?.filename, `attachment_${fileId || index + 1}`);
    if (!fileId || !remoteUrl) return [];
    const mimeType = String(raw?.content_type ?? "").trim();
    const audio = mimeType.startsWith("audio/") || /\.(?:ogg|oga|opus|mp3|m4a|wav|webm)$/i.test(fileName);
    return [{
      fileId,
      fileName,
      ...(mimeType ? { mimeType } : {}),
      ...(raw?.size === undefined ? {} : { fileSize: Number(raw.size) }),
      ...(raw?.duration_secs === undefined ? {} : { durationSeconds: Number(raw.duration_secs) }),
      remoteUrl,
      ...(audio ? { kind: "audio" as const } : {}),
    }];
  });
}

export function adaptDiscordMessage(data: any, surfaceIdentity = "discord:interactive"): InteractiveTurnInput | null {
  const chatKey = String(data?.channel_id ?? "");
  const actorId = String(data?.author?.id ?? "");
  const messageId = String(data?.id ?? "");
  const text = String(data?.content ?? "").trim();
  const attachments = discordAttachments(data);
  if (!chatKey || !actorId || !messageId || (!text && attachments.length === 0)) return null;
  return {
    surfaceIdentity,
    chatKey,
    actorId,
    messageId,
    text,
    ...(data?.guild_id == null ? {} : { conversationScopeId: String(data.guild_id) }),
    delivery: { chatId: chatKey, chatType: data?.guild_id ? "supergroup" : "private" },
    attachments,
  };
}

type FlushFn = (groupId: string | null, turns: InteractiveTurnInput[]) => void | Promise<void>;
interface BufferEntry { timer?: NodeJS.Timeout; turns: InteractiveTurnInput[]; flushing: boolean; resolves: Array<() => void>; }

export class InteractiveTurnBuffer {
  private readonly groups = new Map<string, BufferEntry>();
  constructor(
    private readonly onFlush: FlushFn,
    private readonly timeoutMs = 1500,
  ) {}

  private async flush(groupId: string | null, turns: InteractiveTurnInput[]): Promise<void> {
    await this.onFlush(groupId, turns);
  }

  push(turn: InteractiveTurnInput): Promise<void> {
    if (!turn.mediaGroupId) return this.flush(null, [turn]).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error));
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
      this.flush(turn.mediaGroupId!, turns).catch((error) => console.error("[InteractiveTurnBuffer] onFlush error", error)).finally(() => resolves.forEach((resolve) => resolve()));
    }, this.timeoutMs);
    return pending;
  }
}
