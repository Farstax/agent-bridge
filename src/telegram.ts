import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TelegramMessage } from "./types.js";
import { TELEGRAM_SURFACE_CAPABILITIES, type FileSendOptions, type MessagingPlatform } from "./platform.js";

const TELEGRAM_FILE_BASE_URL = "https://api.telegram.org/file/bot";
const TELEGRAM_LONG_POLL_HEADROOM_MS = 30_000;
const TELEGRAM_POLL_WATCHDOG_GRACE_MS = 15_000;

const MIME_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
};

function mimeTypeFromExtension(filePath: string): string {
  return MIME_TYPE_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
  retry_after?: number;
}

export class TelegramHttpError extends Error {
  readonly status: number;
  readonly data: any;
  readonly retryAfter: number | null;

  constructor(status: number, data: any) {
    const detail = data?.description ? `: ${data.description}` : "";
    super(`Telegram HTTP ${status}${detail}`);
    this.name = "TelegramHttpError";
    this.status = status;
    this.data = data;
    this.retryAfter = data?.parameters?.retry_after ?? data?.retry_after ?? null;
  }
}

export function isTelegramPermanentAuthError(error: unknown): error is TelegramHttpError {
  return error instanceof TelegramHttpError && (error.status === 401 || error.status === 403);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Telegram request aborted");
  error.name = "AbortError";
  return error;
}

async function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) throw abortError(signal);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class TelegramClient implements MessagingPlatform {
  readonly capabilities = TELEGRAM_SURFACE_CAPABILITIES;
  private readonly token: string;
  fetch: typeof fetch;
  baseUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly shutdownSignal?: AbortSignal;

  constructor(token: string, fetchImpl = fetch, fetchTimeoutMs = 45_000, shutdownSignal?: AbortSignal) {
    this.token = token;
    this.fetch = fetchImpl;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetchTimeoutMs = fetchTimeoutMs;
    this.shutdownSignal = shutdownSignal;
  }

  async call<T>(
    method: string,
    body: any = {},
    retryCount = 0,
    requestTimeoutMs = this.fetchTimeoutMs,
    signal = this.shutdownSignal,
  ): Promise<TelegramResponse<T>> {
    const payload = { ...body };
    if (payload.reply_markup && typeof payload.reply_markup === "object") {
      payload.reply_markup = JSON.stringify(payload.reply_markup);
    }

    const ac = new AbortController();
    const onShutdownAbort = () => ac.abort(signal?.reason);
    if (signal?.aborted) ac.abort(signal.reason);
    else signal?.addEventListener("abort", onShutdownAbort, { once: true });
    const fetchTimer = setTimeout(() => ac.abort(), requestTimeoutMs);
    let response: Response;
    let data: any = null;
    try {
      response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });

      try {
        data = await response.json();
      } catch (err) {
        if (ac.signal.aborted) throw err;
        data = null;
      }
    } finally {
      clearTimeout(fetchTimer);
      signal?.removeEventListener("abort", onShutdownAbort);
    }

    if (!response.ok) {
      const error = new TelegramHttpError(response.status, data);

      if (error.status === 429 && error.retryAfter && retryCount < 2) {
        console.warn(`[telegram] rate limited, retrying after ${error.retryAfter}s (attempt ${retryCount + 1})`);
        await waitForRetryDelay(error.retryAfter * 1000, signal);
        return this.call<T>(method, body, retryCount + 1, requestTimeoutMs, signal);
      }

      throw error;
    }

    if (!data.ok) {
      throw new Error(data.description || `Telegram ${method} failed`);
    }
    return data;
  }

  async getUpdates(options: any): Promise<TelegramResponse<any[]>> {
    const longPollTimeoutMs =
      typeof options?.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0
        ? options.timeout * 1000 + TELEGRAM_LONG_POLL_HEADROOM_MS
        : this.fetchTimeoutMs;
    const requestTimeoutMs = Math.max(this.fetchTimeoutMs, longPollTimeoutMs);
    const watchdogMs = requestTimeoutMs + TELEGRAM_POLL_WATCHDOG_GRACE_MS;
    const watchdog = setTimeout(() => {
      console.error(`[telegram] getUpdates exceeded ${watchdogMs}ms liveness deadline; exiting for supervised restart`);
      process.exit(1);
    }, watchdogMs);

    try {
      return await this.call(
        "getUpdates",
        options,
        0,
        requestTimeoutMs,
      );
    } finally {
      clearTimeout(watchdog);
    }
  }

  async sendMessage(body: any): Promise<TelegramResponse<TelegramMessage>> {
    return this.call("sendMessage", body);
  }

  // Bot API 10.1: payload shape is { chat_id, rich_message: { html: "..." } }
  async sendRichMessage(body: { chat_id: number | string; rich_message: { html: string }; [key: string]: any }): Promise<TelegramResponse<TelegramMessage>> {
    return this.call("sendRichMessage", body);
  }

  async answerCallbackQuery(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("answerCallbackQuery", body);
  }

  async editMessageText(body: any): Promise<TelegramResponse<TelegramMessage>> {
    return this.call("editMessageText", body);
  }

  async deleteMessage(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("deleteMessage", body);
  }

  async sendChatAction(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("sendChatAction", body);
  }

  async setMyCommands(body: any): Promise<TelegramResponse<boolean>> {
    return this.call("setMyCommands", body);
  }

  async getFilePath(fileId: string): Promise<string> {
    const url = `${this.baseUrl}/getFile?file_id=${encodeURIComponent(fileId)}`;
    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    try {
      const response = await this.fetch(url, { signal: ac.signal } as any);
      if (!response.ok) {
        throw new Error(`Telegram getFile HTTP ${response.status}`);
      }
      const data = await response.json() as any;
      return data.result.file_path as string;
    } finally {
      clearTimeout(fetchTimer);
    }
  }

  async downloadFile(filePath: string, destPath: string): Promise<void> {
    const url = `${TELEGRAM_FILE_BASE_URL}${this.token}/${filePath}`;
    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    let buffer: ArrayBuffer;
    try {
      const response = await this.fetch(url, { signal: ac.signal } as any);
      if (!response.ok) {
        throw new Error(`Telegram downloadFile HTTP ${response.status}`);
      }
      buffer = await response.arrayBuffer();
    } finally {
      clearTimeout(fetchTimer);
    }
    await writeFile(destPath, Buffer.from(buffer));
  }

  private async sendFile(
    endpoint: string,
    fieldName: string,
    chatId: number | string,
    filePath: string,
    caption?: string,
    options?: FileSendOptions,
  ): Promise<void> {
    const fileBytes = readFileSync(filePath);
    const mimeType = mimeTypeFromExtension(filePath);
    const blob = new Blob([fileBytes], { type: mimeType });
    const fd = new FormData();
    fd.set("chat_id", String(chatId));
    fd.set(fieldName, blob, basename(filePath));
    if (caption) fd.set("caption", caption);
    if (options?.message_thread_id != null) fd.set("message_thread_id", String(options.message_thread_id));

    const url = `${this.baseUrl}/${endpoint}`;
    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    let response: Response;
    let data: any = null;
    try {
      response = await this.fetch(url, { method: "POST", body: fd, signal: ac.signal } as any);
      try {
        data = await response.json();
      } catch (err) {
        if (ac.signal.aborted) throw err;
        data = null;
      }
    } finally {
      clearTimeout(fetchTimer);
    }
    if (!response.ok || data?.ok === false) {
      const detail = data?.description ? `: ${data.description}` : "";
      throw new Error(`Telegram ${endpoint} HTTP ${response.status}${detail}`);
    }
    if (data?.ok !== true) {
      throw new Error(`Telegram ${endpoint} response missing ok:true`);
    }
  }

  async sendDocument(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void> {
    return this.sendFile("sendDocument", "document", chatId, filePath, caption, options);
  }

  async sendDocumentBuffer(body: {
    chat_id: number | string;
    bytes: Buffer;
    filename: string;
    mime_type?: string;
    caption?: string;
    [key: string]: any;
  }): Promise<TelegramResponse<TelegramMessage>> {
    const { bytes, filename, mime_type: mimeType = "application/octet-stream", ...fields } = body;
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      fd.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const fileBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    fd.set("document", new File([fileBytes], filename, { type: mimeType }));

    const url = `${this.baseUrl}/sendDocument`;
    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    let response: Response;
    let data: any = null;
    try {
      response = await this.fetch(url, { method: "POST", body: fd, signal: ac.signal } as any);
      try {
        data = await response.json();
      } catch (err) {
        if (ac.signal.aborted) throw err;
        data = null;
      }
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!response.ok || data?.ok === false) {
      const detail = data?.description ? `: ${data.description}` : "";
      throw new Error(`Telegram sendDocument HTTP ${response.status}${detail}`);
    }
    if (data?.ok !== true) {
      throw new Error("Telegram sendDocument response missing ok:true");
    }
    return data;
  }

  async sendPhoto(chatId: number | string, filePath: string, caption?: string, options?: FileSendOptions): Promise<void> {
    return this.sendFile("sendPhoto", "photo", chatId, filePath, caption, options);
  }

}

type FlushFn = (groupId: string | null, messages: TelegramMessage[]) => void | Promise<void>;

interface BufferEntry {
  timer: NodeJS.Timeout | undefined;
  messages: TelegramMessage[];
  flushing: boolean;
  resolves: (() => void)[];
}

export class MediaGroupBuffer {
  timeoutMs: number;
  onFlush: FlushFn;
  groups: Map<string, BufferEntry>;

  constructor({ timeoutMs = 1500, onFlush }: { timeoutMs?: number; onFlush: FlushFn }) {
    this.timeoutMs = timeoutMs;
    this.onFlush = onFlush;
    this.groups = new Map();
  }

  push(message: TelegramMessage): Promise<void> {
    const groupId = message.media_group_id;
    if (!groupId) {
      return Promise.resolve(this.onFlush(null, [message])).catch((err) => {
        console.error("[MediaGroupBuffer] onFlush error", err);
      });
    }

    let entry = this.groups.get(groupId);
    // If the entry is already being flushed, start a fresh one for new messages.
    if (entry && !entry.flushing) {
      clearTimeout(entry.timer);
    } else {
      entry = { timer: undefined, messages: [], flushing: false, resolves: [] };
      this.groups.set(groupId, entry);
    }

    entry.messages.push(message);
    const p = new Promise<void>((resolve) => {
      entry!.resolves.push(resolve);
    });

    entry.timer = setTimeout(() => {
      entry!.flushing = true;
      const messages = [...entry!.messages]; // snapshot before delete
      const resolves = [...entry!.resolves];
      this.groups.delete(groupId);
      Promise.resolve(this.onFlush(groupId, messages))
        .then(() => {
          resolves.forEach((r) => r());
        })
        .catch((err) => {
          console.error("[MediaGroupBuffer] onFlush error", err);
          resolves.forEach((r) => r());
        });
    }, this.timeoutMs);

    return p;
  }
}
