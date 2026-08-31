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
import { DiscordGateway, type GatewayPayload } from "./discord-gateway.js";
import { discordMarkdownIrEnabled, parseMarkdownToIR, renderMarkerString, DISCORD_MARKERS } from "./markdownIR.js";

const DISCORD_API = "https://discord.com/api/v10";
export const MAX_DISCORD_MESSAGE_LENGTH = 1990;

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
    for (const chunk of chunks) {
      last = await this._restPost(`/channels/${channelId}/messages`, { content: chunk });
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

  private async _restPost(path: string, body: object): Promise<any> {
    const res = await this.fetchFn(`${DISCORD_API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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

export function chunkText(text: string): string[] {
  if (text.length <= MAX_DISCORD_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, MAX_DISCORD_MESSAGE_LENGTH));
    remaining = remaining.slice(MAX_DISCORD_MESSAGE_LENGTH);
  }
  return chunks;
}
