import type { TelegramMessage, TelegramUpdate } from "./types.js";

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
