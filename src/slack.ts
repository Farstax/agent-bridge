/**
 * PURPOSE: Slack transport adapter (#943): a thin MessagingPlatform over the
 * official Web API client. Only plain-text threaded posts are supported; every
 * other capability fails explicitly. Writes are never retried blindly: only a
 * confirmed 429 is retried, and any other uncertain outcome is surfaced as an
 * ambiguous failure the shared delivery helper must not repeat.
 * INPUTS: chat_id (Slack channel), message_thread_id (Slack ts), text.
 * OUTPUTS: { ok, id (message ts), ts, channel }.
 * NEIGHBORS: src/platform.ts, src/messageDelivery.ts, src/index-slack-interactive.ts
 */
import { SLACK_SURFACE_CAPABILITIES, type MessagingPlatform, type SurfaceCapabilities, type TransportRequest } from "./platform.js";

export const SLACK_MAX_CHUNK = 3500;
const MAX_RATE_LIMIT_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const CHANNEL_SPACING_MS = 1_000;

export interface SlackPostingClient {
  chat: { postMessage(args: any): Promise<any> };
}

/** Delivery failure whose retryability the shared helper can read from `status`. */
export class SlackDeliveryError extends Error {
  /** Only a confirmed rate limit carries 429; every other failure is deliberately status-less. */
  status?: number;
  finalChunksDelivered?: number;
  constructor(message: string, readonly slackCode: string, readonly outcome: "rejected" | "rate_limited" | "ambiguous") {
    super(message);
    this.name = "SlackDeliveryError";
    if (outcome === "rate_limited") this.status = 429;
  }
}

/** Escapes Slack control sequences so model output cannot ping or link. */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function chunkSlackText(text: string, limit = SLACK_MAX_CHUNK): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function classify(error: unknown): SlackDeliveryError {
  const e = error as { code?: string; retryAfter?: number; data?: { error?: string }; statusCode?: number; message?: string };
  if (e?.code === "slack_webapi_rate_limited_error") {
    const err = new SlackDeliveryError("Slack rate limited the post", "rate_limited", "rate_limited");
    (err as SlackDeliveryError & { retryAfterMs?: number }).retryAfterMs = Math.min(Math.max(Number(e.retryAfter) || 1, 1) * 1000, MAX_RETRY_AFTER_MS);
    return err;
  }
  if (e?.code === "slack_webapi_platform_error") {
    // Slack answered ok:false: the message was definitely not posted.
    return new SlackDeliveryError(`Slack rejected the post: ${e.data?.error ?? "unknown_error"}`, e.data?.error ?? "unknown_error", "rejected");
  }
  return new SlackDeliveryError("Slack post outcome is uncertain", "ambiguous", "ambiguous");
}

export interface SlackClientOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  channelSpacingMs?: number;
}

export class SlackClient implements MessagingPlatform {
  readonly capabilities: SurfaceCapabilities = SLACK_SURFACE_CAPABILITIES;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly nextAllowedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly spacingMs: number;

  constructor(private readonly web: SlackPostingClient, options: SlackClientOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.spacingMs = options.channelSpacingMs ?? CHANNEL_SPACING_MS;
  }

  async sendMessage(body: TransportRequest): Promise<any> {
    const channel = String(body.chat_id ?? "");
    if (!channel) throw new SlackDeliveryError("Slack channel is required", "channel_required", "rejected");
    const threadTs = body.message_thread_id === undefined || body.message_thread_id === null || body.message_thread_id === ""
      ? undefined
      : String(body.message_thread_id);
    const chunks = chunkSlackText(escapeSlackText(String(body.text ?? "")));
    // Serialise per native channel so ordering and the 1 post/second target hold.
    const previous = this.tails.get(channel) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      let last: any = null;
      for (let index = 0; index < chunks.length; index += 1) {
        try {
          last = await this.postChunk(channel, threadTs, chunks[index]);
        } catch (error) {
          if (index > 0 && error && typeof error === "object") (error as SlackDeliveryError).finalChunksDelivered = index;
          throw error;
        }
      }
      return last;
    });
    this.tails.set(channel, run.catch(() => undefined));
    return run;
  }

  private async postChunk(channel: string, threadTs: string | undefined, text: string): Promise<any> {
    for (let attempt = 1; ; attempt += 1) {
      const wait = (this.nextAllowedAt.get(channel) ?? 0) - this.now();
      if (wait > 0) await this.sleep(wait);
      try {
        const response = await this.web.chat.postMessage({
          channel,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
          unfurl_links: false,
          unfurl_media: false,
          mrkdwn: false,
        });
        this.nextAllowedAt.set(channel, this.now() + this.spacingMs);
        const ts = typeof response?.ts === "string" ? response.ts : null;
        if (!response?.ok || !ts) throw new SlackDeliveryError("Slack post response was not confirmed", "unconfirmed", "ambiguous");
        return { ok: true, id: ts, ts, channel: typeof response.channel === "string" ? response.channel : channel };
      } catch (error) {
        const failure = error instanceof SlackDeliveryError ? error : classify(error);
        if (failure.outcome === "rate_limited" && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
          const delay = (failure as SlackDeliveryError & { retryAfterMs?: number }).retryAfterMs ?? 1_000;
          this.nextAllowedAt.set(channel, this.now() + delay);
          continue;
        }
        throw failure;
      }
    }
  }

  private unsupported(operation: string): never {
    throw new Error(`Slack surface does not support ${operation}`);
  }
  async editMessageText(_body: TransportRequest): Promise<any> { return this.unsupported("editing messages"); }
  async deleteMessage(_body: TransportRequest): Promise<any> { return this.unsupported("deleting messages"); }
  async sendChatAction(_body: TransportRequest): Promise<any> { return { ok: true }; }
  async answerCallbackQuery(_body: TransportRequest): Promise<any> { return this.unsupported("interactive callbacks"); }
  async setMyCommands(_body: TransportRequest): Promise<any> { return { ok: true }; }
  async sendDocument(): Promise<void> { return this.unsupported("attachments"); }
  async sendPhoto(): Promise<void> { return this.unsupported("attachments"); }
}
