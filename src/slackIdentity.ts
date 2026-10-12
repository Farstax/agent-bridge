/**
 * PURPOSE: Bind the Slack bot token and the app-level (Socket Mode) token to one
 * verified app and team (#943). The bot token is verified through auth.test and
 * bots.info; the app-level token is verified by the app_id Slack states in the
 * hello message of the actual runtime socket, never by `connected` alone.
 * INPUTS: Slack WebClient, Socket Mode options, expected identity.
 * OUTPUTS: SlackBotIdentity, VerifiedSocketModeClient.
 * NEIGHBORS: src/slack.ts, src/index-slack-interactive.ts
 */
import { SocketModeClient } from "@slack/socket-mode";
import type { SocketModeOptions } from "@slack/socket-mode";

export interface SlackBotIdentity {
  teamId: string;
  botUserId: string;
  botId: string;
  appId: string;
}

/** The subset of the Web API client the verification needs. */
export interface SlackIdentityWebClient {
  auth: { test(): Promise<any> };
  bots: { info(args: { bot: string }): Promise<any> };
}

export class SlackIdentityError extends Error {
  /** True only when Slack stated the credentials or app are unusable (not a transport failure). */
  constructor(readonly code: SlackIdentityErrorCode, message: string, readonly permanent = false) {
    super(message);
    this.name = "SlackIdentityError";
  }
}
export type SlackIdentityErrorCode =
  | "token_invalid"
  | "token_class_unsupported"
  | "identity_unavailable"
  | "app_mismatch"
  | "app_unverified";

/** Only classic, non-expiring tokens are supported in v1. */
export function assertSupportedSlackTokens(botToken: string, appToken: string): void {
  if (/^xoxe[.-]/i.test(botToken) || /^xoxe[.-]/i.test(appToken) || /^xoxe-?\d/i.test(botToken)) {
    throw new SlackIdentityError("token_class_unsupported", "Rotating (xoxe) Slack tokens are not supported: disable token rotation for the app and use non-expiring tokens.");
  }
  if (!/^xoxb-/.test(botToken)) throw new SlackIdentityError("token_invalid", "SLACK_BOT_TOKEN must be a bot token (xoxb-...).");
  if (!/^xapp-/.test(appToken)) throw new SlackIdentityError("token_invalid", "SLACK_APP_TOKEN must be an app-level token (xapp-...).");
}

const PERMANENT_AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "bot_not_found", "team_access_not_granted", "no_permission"]);

export async function verifySlackBotIdentity(web: SlackIdentityWebClient): Promise<SlackBotIdentity> {
  let auth: any;
  try {
    auth = await web.auth.test();
  } catch (error) {
    const reason = safeSlackErrorCode(error);
    throw new SlackIdentityError("token_invalid", `Slack bot token verification failed: ${reason}`, PERMANENT_AUTH_ERRORS.has(reason));
  }
  const teamId = str(auth?.team_id);
  const botUserId = str(auth?.user_id);
  const botId = str(auth?.bot_id);
  if (!teamId || !botUserId || !botId) throw new SlackIdentityError("identity_unavailable", "Slack auth.test did not return a team, bot user and bot ID.", true);
  let info: any;
  try {
    info = await web.bots.info({ bot: botId });
  } catch (error) {
    const reason = safeSlackErrorCode(error);
    throw new SlackIdentityError("identity_unavailable", `Slack bots.info failed (the users:read scope is required): ${reason}`, PERMANENT_AUTH_ERRORS.has(reason) || reason === "missing_scope");
  }
  const appId = str(info?.bot?.app_id);
  if (!appId) throw new SlackIdentityError("identity_unavailable", "Slack bots.info did not return an app ID.", true);
  return { teamId, botUserId, botId, appId };
}

export function safeSlackErrorCode(error: unknown): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (typeof data?.error === "string") return data.error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "request_failed";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface VerifiedSocketHooks {
  /** The hello message on the live socket carried the expected app ID. */
  onVerified(): void;
  /** The hello message was missing or carried another app ID; the socket was closed. */
  onRejected(code: "app_mismatch" | "app_unverified"): void;
}

/**
 * Socket Mode client that refuses to dispatch any envelope until the actual
 * runtime socket's hello message proves the app-level token belongs to the
 * expected app. The SDK consumes the hello packet itself and emits `connected`
 * with the apps.connections.open response, which does not prove identity, so
 * the protected message handler is narrowly overridden. A contract test pins
 * this dependency on the SDK internals.
 */
export class VerifiedSocketModeClient extends SocketModeClient {
  private verifiedSocket = false;

  constructor(options: SocketModeOptions, private readonly expectedAppId: string, private readonly hooks: VerifiedSocketHooks) {
    super(options);
    // A new socket must re-prove its identity.
    this.on("close", () => { this.verifiedSocket = false; });
  }

  get socketVerified(): boolean { return this.verifiedSocket; }

  protected override async onWebSocketMessage(data: string | ArrayBuffer, isBinary: boolean): Promise<void> {
    if (isBinary) return;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    let type: unknown;
    let helloAppId: unknown;
    try {
      const parsed = JSON.parse(text);
      type = parsed?.type;
      helloAppId = parsed?.connection_info?.app_id;
    } catch {
      return;
    }
    if (type === "hello") {
      this.verifiedSocket = false;
      if (typeof helloAppId !== "string" || helloAppId.length === 0 || helloAppId !== this.expectedAppId) {
        const code = typeof helloAppId === "string" && helloAppId.length > 0 ? "app_mismatch" : "app_unverified";
        // Never reconnect with a token that belongs to another app.
        (this as unknown as { autoReconnectEnabled: boolean }).autoReconnectEnabled = false;
        this.hooks.onRejected(code);
        await this.disconnect().catch(() => undefined);
        return;
      }
      this.verifiedSocket = true;
      this.hooks.onVerified();
    } else if (!this.verifiedSocket) {
      // No envelope is acknowledged or dispatched on an unproven socket.
      return;
    }
    await super.onWebSocketMessage(data, isBinary);
  }
}
