/**
 * DiscordClient — implements MessagingPlatform for Discord.
 *
 * Transport: WebSocket Gateway (via DiscordGateway) for receiving events.
 * Sending: REST API (https://discord.com/api/v10/...).
 *
 * Key differences from TelegramClient:
 *   - 2000-char message limit (vs Telegram's 4096)
 *   - No sendChatAction equivalent — uses POST /channels/{id}/typing
 *   - No getUpdates (push-based via WebSocket)
 *   - answerCallbackQuery → POST /interactions/{id}/{token}/callback
 *   - setMyCommands → PUT /applications/{id}/commands (global or guild)
 *   - Slash commands: must ACK within 3 seconds with deferred response
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { DISCORD_SURFACE_CAPABILITIES, type MessagingPlatform } from "./platform.js";
import type { InteractiveSurroundingContextMessage } from "./interactiveIngress.js";
import { DiscordGateway, type GatewayPayload } from "./discord-gateway.js";
import { discordMarkdownIrEnabled, parseMarkdownToIR, renderMarkerString, DISCORD_MARKERS } from "./markdownIR.js";

const DISCORD_API = "https://discord.com/api/v10";
export const MAX_DISCORD_MESSAGE_LENGTH = 1990;
export const MAX_DISCORD_SURROUNDING_MESSAGES = 6;
export const MAX_DISCORD_SURROUNDING_CHARS = 3_000;
const MAX_DISCORD_SURROUNDING_MESSAGE_CHARS = 800;
const MAX_DISCORD_RATE_LIMIT_RETRIES = 5;
const MAX_DISCORD_RATE_LIMIT_WAIT_MS = 15_000;
const DISCORD_MESSAGE_POST_PATH = /^\/channels\/[^/]+\/messages$/;
const MAX_DISCORD_ACTOR_LABEL_CHARS = 80;

export interface DiscordUpdate {
  type: "MESSAGE_CREATE" | "INTERACTION_CREATE" | string;
  data: any;
}

export type DiscordUpdateHandler = (update: DiscordUpdate) => void;

export interface DiscordClientOptions {
  token: string;
  applicationId: string;
  /** Optional: restrict slash command registration to one guild (instant propagation). */
  guildId?: string;
  onUpdate: DiscordUpdateHandler;
  onReady?: () => void;
  onError?: (err: Error) => void;
}

export interface DiscordSurroundingContextRequest {
  channelId: string;
  beforeMessageId: string;
  guildId?: string;
}

export function boundDiscordSurroundingContext(
  messages: readonly any[],
  request: DiscordSurroundingContextRequest,
): InteractiveSurroundingContextMessage[] {
  const bounded: InteractiveSurroundingContextMessage[] = [];
  let remainingChars = MAX_DISCORD_SURROUNDING_CHARS;

  // Discord returns channel history newest-first. Keep the newest eligible slice,
  // then reverse it so the provider receives the evidence chronologically.
  for (const message of messages) {
    if (bounded.length >= MAX_DISCORD_SURROUNDING_MESSAGES || remainingChars <= 0) break;
    const messageId = String(message?.id ?? "");
    const channelId = message?.channel_id == null ? "" : String(message.channel_id);
    const guildId = message?.guild_id == null ? undefined : String(message.guild_id);
    if (!messageId || messageId === request.beforeMessageId) continue;
    if (channelId !== request.channelId) continue;
    // GET /channels/{id}/messages returns the base Message object, whose REST
    // schema does not include top-level guild_id. The channel ID is therefore
    // the hard native scope boundary; guild_id is an additional check when present.
    if (request.guildId) {
      if (guildId && guildId !== request.guildId) continue;
    } else if (guildId) {
      continue;
    }

    const actorId = String(message?.author?.id ?? "");
    if (!actorId) continue;
    const rawText = String(message?.content ?? "").trim();
    if (!rawText) continue;
    const text = rawText.slice(0, Math.min(MAX_DISCORD_SURROUNDING_MESSAGE_CHARS, remainingChars)).trim();
    if (!text) continue;
    const rawLabel = String(message?.author?.global_name ?? message?.author?.username ?? actorId);
    const actorLabel = rawLabel.replace(/\s+/g, " ").trim().slice(0, MAX_DISCORD_ACTOR_LABEL_CHARS) || actorId;
    bounded.push({ actorId, actorLabel, messageId, text });
    remainingChars -= text.length;
  }

  return bounded.reverse();
}

export class DiscordClient implements MessagingPlatform {
  readonly capabilities = DISCORD_SURFACE_CAPABILITIES;
  private readonly opts: DiscordClientOptions;
  private readonly gateway: DiscordGateway;
  private readonly fetchFn: typeof fetch;

  // Intents: GUILDS(1) | GUILD_MESSAGES(512) | MESSAGE_CONTENT(32768) | DIRECT_MESSAGES(4096)
  static readonly DEFAULT_INTENTS = 1 | 512 | 32_768 | 4_096;

  constructor(opts: DiscordClientOptions, fetchImpl = fetch) {
    this.opts = opts;
    this.fetchFn = fetchImpl;
    this.gateway = new DiscordGateway({
      token: opts.token,
      intents: DiscordClient.DEFAULT_INTENTS,
      onEvent: (payload) => this._handleGatewayEvent(payload),
      onReady: opts.onReady,
      onError: opts.onError,
    });
  }

  /** Open the WebSocket Gateway connection. */
  connect(): void {
    this.gateway.connect();
  }

  /** Close the gateway and stop all timers. */
  destroy(): void {
    this.gateway.destroy();
  }

  // ── MessagingPlatform ─────────────────────────────────────────────────────

  /** Sends a message to a Discord channel. Chunks at MAX_DISCORD_MESSAGE_LENGTH. */
  async sendMessage(body: {
    chat_id?: number | string;
    channel_id?: string;
    text?: string;
    content?: string;
    [key: string]: any;
  }): Promise<any> {
    const channelId = String(body.channel_id ?? body.chat_id ?? "");
    const rawText = String(body.text ?? body.content ?? "");
    const text = discordMarkdownIrEnabled()
      ? renderMarkerString(parseMarkdownToIR(rawText), DISCORD_MARKERS)
      : rawText;
    const chunks = chunkText(text);
    let last: any = null;
    for (let index = 0; index < chunks.length; index += 1) {
      try {
        last = await this._restPost(`/channels/${channelId}/messages`, { content: chunks[index] }, true);
      } catch (error) {
        // Final-answer recovery must not resend chunks the channel already has.
        if (index > 0 && error && typeof error === "object") {
          (error as { finalChunksDelivered?: number }).finalChunksDelivered = index;
        }
        throw error;
      }
    }
    return last;
  }

  /** Edits an existing Discord message. */
  async editMessageText(body: {
    chat_id?: number | string;
    channel_id?: string;
    message_id?: number | string;
    text?: string;
    content?: string;
    [key: string]: any;
  }): Promise<any> {
    const channelId = String(body.channel_id ?? body.chat_id ?? "");
    const messageId = String(body.message_id ?? "");
    const text = String(body.text ?? body.content ?? "");
    return this._restPatch(`/channels/${channelId}/messages/${messageId}`, { content: truncate(text) });
  }

  /** Sends a typing indicator to a Discord channel. */
  async sendChatAction(body: { chat_id?: number | string; channel_id?: string }): Promise<any> {
    const channelId = String(body.channel_id ?? body.chat_id ?? "");
    return this._restPost(`/channels/${channelId}/typing`, {});
  }

  /** Fetch a bounded, text-only slice before the authoritative triggering message. */
  async getSurroundingContext(request: DiscordSurroundingContextRequest): Promise<InteractiveSurroundingContextMessage[]> {
    const channelId = encodeURIComponent(request.channelId);
    const beforeMessageId = encodeURIComponent(request.beforeMessageId);
    const messages = await this._restGet(`/channels/${channelId}/messages?before=${beforeMessageId}&limit=${MAX_DISCORD_SURROUNDING_MESSAGES}`);
    if (!Array.isArray(messages)) throw new Error("Discord surrounding context response was not an array");
    return boundDiscordSurroundingContext(messages, request);
  }

  /**
   * Answers a Discord interaction (slash command or button).
   * For deferred interactions, use the PATCH /webhooks path instead.
   */
  async answerCallbackQuery(body: {
    callback_query_id?: string;
    interaction_id?: string;
    interaction_token?: string;
    text?: string;
    type?: number;
    /** Full Discord interaction response data — takes precedence over `text` when provided. */
    data?: Record<string, any>;
  }): Promise<any> {
    if (body.interaction_id && body.interaction_token) {
      const responseType = body.type ?? 4; // CHANNEL_MESSAGE_WITH_SOURCE
      const responseData = body.data ?? (body.text ? { content: truncate(body.text) } : {});
      return this._restPost(
        `/interactions/${body.interaction_id}/${body.interaction_token}/callback`,
        { type: responseType, data: responseData },
      );
    }
    return null;
  }

  /**
   * Registers slash commands with Discord.
   * Uses guild commands when guildId is configured (instant); otherwise global (~1h).
   */
  async setMyCommands(body: {
    commands: Array<{ command?: string; name?: string; description: string; type?: number; options?: any[] }>;
    [key: string]: any;
  }): Promise<any> {
    const discordCommands = (body.commands ?? []).map((c) => ({
      name: (c.name || c.command || "").replace(/^\//, ""),
      description: c.description || "No description",
      type: c.type ?? 1,
      options: c.options,
    }));
    const path = this.opts.guildId
      ? `/applications/${this.opts.applicationId}/guilds/${this.opts.guildId}/commands`
      : `/applications/${this.opts.applicationId}/commands`;
    return this._restPut(path, discordCommands);
  }

  /** Sends a file to a Discord channel as an attachment. */
  async sendDocument(chatId: number | string, filePath: string, caption?: string, _options?: unknown): Promise<void> {
    await this._sendFile(String(chatId), filePath, caption);
  }

  /** Sends an image to a Discord channel as an attachment. */
  async sendPhoto(chatId: number | string, filePath: string, caption?: string, _options?: unknown): Promise<void> {
    await this._sendFile(String(chatId), filePath, caption);
  }

  // ── Private REST helpers ─────────────────────────────────────────────────

  private async _restGet(path: string): Promise<any> {
    const res = await this.fetchFn(`${DISCORD_API}${path}`, {
      method: "GET",
      headers: { Authorization: `Bot ${this.opts.token}` },
    });
    if (!res.ok) throw new Error(`Discord GET ${path} HTTP ${res.status}`);
    return res.json();
  }

  private async _restPost(path: string, body: object, requireOk = false): Promise<any> {
    let res: any;
    for (let attempt = 0; ; attempt += 1) {
      res = await this.fetchFn(`${DISCORD_API}${path}`, {
        method: "POST",
        headers: { Authorization: `Bot ${this.opts.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      // HTTP 429 is a definite rejection: Discord did not create the message,
      // so waiting for retry_after and re-posting cannot duplicate it.
      // Only channel message posts are retried. Interaction callbacks have a
      // 3 s acknowledgement deadline and typing indicators are best-effort.
      if (res.status !== 429 || !DISCORD_MESSAGE_POST_PATH.test(path) || attempt >= MAX_DISCORD_RATE_LIMIT_RETRIES) break;
      const delayMs = await discordRetryDelayMs(res);
      // A wait longer than the cap is a global or ban-style limit. Surface the
      // 429 instead of re-hitting the endpoint early.
      if (delayMs > MAX_DISCORD_RATE_LIMIT_WAIT_MS) break;
      await sleep(delayMs);
    }
    if (requireOk && res.ok === false) {
      // A rejected message post must not look delivered (HTTP status is the only
      // evidence callers have that the message was definitely not created).
      const error = new Error(`Discord POST ${path} HTTP ${res.status}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : res.json();
  }

  private async _restPatch(path: string, body: object): Promise<any> {
    const res = await this.fetchFn(`${DISCORD_API}${path}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${this.opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async _restPut(path: string, body: object): Promise<any> {
    const res = await this.fetchFn(`${DISCORD_API}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bot ${this.opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  private async _sendFile(channelId: string, filePath: string, caption?: string): Promise<void> {
    const fileBytes = readFileSync(filePath);
    const fd = new FormData();
    const blob = new Blob([fileBytes]);
    fd.set("files[0]", blob, basename(filePath));
    if (caption) fd.set("payload_json", JSON.stringify({ content: truncate(caption) }));
    const res = await this.fetchFn(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.opts.token}` },
      body: fd as any,
    });
    if (!res.ok) throw new Error(`Discord sendFile HTTP ${res.status}`);
  }

  // ── Gateway event routing ────────────────────────────────────────────────

  private _handleGatewayEvent(payload: GatewayPayload): void {
    if (!payload.t) return;
    this.opts.onUpdate({ type: payload.t, data: payload.d });
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function truncate(text: string): string {
  return text.length > MAX_DISCORD_MESSAGE_LENGTH ? text.slice(-MAX_DISCORD_MESSAGE_LENGTH) : text;
}

interface MarkdownFence {
  closer: string;
  reopen: string;
}

const MAX_FENCE_INFO_CHARS = 40;

function openingFence(line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!match) return null;
  const [, marker, info] = match;
  if (marker.startsWith("`") && info.includes("`")) return null;
  return { closer: marker, reopen: `${marker}${info.trim().slice(0, MAX_FENCE_INFO_CHARS)}` };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!match && match[1][0] === fence.closer[0] && match[1].length >= fence.closer.length;
}

/**
 * Splits a Discord message on blank-line and line boundaries so list items and
 * paragraphs stay whole. A fenced code block that crosses a boundary is closed
 * at the end of one chunk and reopened at the start of the next. Only a single
 * line longer than the limit is split by code point.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discordRetryDelayMs(res: any): Promise<number> {
  const header = res.headers?.get?.("retry-after");
  let seconds = header === null || header === undefined || header === "" ? Number.NaN : Number(header);
  try {
    const body = await res.json();
    if (typeof body?.retry_after === "number") seconds = body.retry_after;
  } catch {
    // Keep the header value or the default below.
  }
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.ceil(seconds * 1000) + 50;
}

export function chunkText(text: string): string[] {
  const limit = MAX_DISCORD_MESSAGE_LENGTH;
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let lines: string[] = [];
  let length = 0;
  let fence: MarkdownFence | null = null;
  let lastBlank = -1;

  const measure = (): void => {
    length = lines.reduce((total, line, index) => total + line.length + (index ? 1 : 0), 0);
  };
  const emit = (count: number, closeFence: boolean): void => {
    const head = lines.slice(0, count);
    while (head.length && head[head.length - 1].trim() === "") head.pop();
    if (head.length) chunks.push(head.join("\n") + (closeFence && fence ? `\n${fence.closer}` : ""));
  };

  const add = (line: string): void => {
    const opens = fence ? null : openingFence(line);
    const reserveFence = fence ?? opens;
    const reserve = reserveFence ? reserveFence.closer.length + 1 : 0;
    while (lines.length && length + 1 + line.length + reserve > limit) {
      if (!fence && lastBlank > 0) {
        emit(lastBlank, false);
        lines = lines.slice(lastBlank + 1);
        while (lines.length && lines[0].trim() === "") lines.shift();
      } else {
        emit(lines.length, true);
        lines = fence ? [fence.reopen] : [];
      }
      lastBlank = -1;
      measure();
    }
    lines.push(line);
    length += (lines.length > 1 ? 1 : 0) + line.length;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (opens) {
      fence = opens;
    } else if (line.trim() === "") {
      lastBlank = lines.length - 1;
    }
  };

  for (const rawLine of text.split("\n")) {
    const opens = fence ? null : openingFence(rawLine);
    const line = opens ? `${rawLine.match(/^ {0,3}/)![0]}${opens.reopen}` : rawLine;
    const active = fence as MarkdownFence | null;
    const cap = active ? limit - (active.reopen.length + active.closer.length + 2) : limit;
    if (line.length <= cap) {
      add(line);
      continue;
    }
    let piece = "";
    for (const point of Array.from(line)) {
      if (piece.length + point.length > cap) {
        add(piece);
        piece = "";
      }
      piece += point;
    }
    if (piece) add(piece);
  }
  if (lines.length) emit(lines.length, true);
  return chunks;
}
