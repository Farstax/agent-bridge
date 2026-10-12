/**
 * PURPOSE: Slack event normalisation and durable admission (#943). Classifies
 * an authenticated Socket Mode events_api envelope into "ignore" or one
 * InteractiveTurnInput, and persists a minimal recoverable receipt before the
 * envelope is acknowledged. Slack is a thin transport: execution, queueing,
 * fallback and delivery stay with the existing owners.
 * INPUTS: events_api body, verified identity, allowlist.
 * OUTPUTS: SlackAdmissionDecision, receipts in event_receipts (source=slack).
 * NEIGHBORS: src/interactiveIngress.ts, src/index-slack-interactive.ts
 */
import type { BridgeDb, EventReceipt } from "./db.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";

export const SLACK_RECEIPT_SOURCE = "slack" as const;
export const SLACK_EVENT_KIND = "events_api" as const;
export const SLACK_MAX_TEXT_BYTES = 16 * 1024;
export const SLACK_MAX_UNDISPATCHED = 200;

const COMMANDS: Readonly<Record<string, string>> = {
  "!stop": "/stop",
  "!cancel": "/cancel",
  "!reset": "/reset",
  "!cli": "/cli",
};

export interface SlackVerifiedContext {
  teamId: string;
  appId: string;
  botUserId: string;
  allowedUserIds: ReadonlySet<string>;
}

export type SlackIgnoreReason =
  | "identity_mismatch" | "enterprise_install" | "unsupported_event" | "subtype" | "bot_author" | "self"
  | "unauthorized" | "not_mentioned" | "empty" | "too_large" | "malformed";

export type SlackAdmissionDecision =
  | { kind: "ignore"; reason: SlackIgnoreReason }
  | { kind: "turn"; turn: InteractiveTurnInput; eventId: string; idempotencyKey: string; occurredAt: string };

export function slackSurfaceIdentity(teamId: string, appId: string): string {
  return `slack:${teamId}:${appId}`;
}

function unescapeSlack(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function tsToIso(ts: string): string {
  const seconds = Number(ts);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : new Date().toISOString();
}

export function classifySlackEnvelope(body: any, context: SlackVerifiedContext): SlackAdmissionDecision {
  const event = body?.event;
  const eventId = body?.event_id;
  if (!event || typeof eventId !== "string" || !eventId || typeof body?.team_id !== "string" || typeof body?.api_app_id !== "string") {
    return { kind: "ignore", reason: "malformed" };
  }
  if (body.team_id !== context.teamId || body.api_app_id !== context.appId) return { kind: "ignore", reason: "identity_mismatch" };
  if (body.is_ext_shared_channel === true || body.is_enterprise_install === true) return { kind: "ignore", reason: "enterprise_install" };
  const type = event.type;
  const isDm = type === "message" && event.channel_type === "im";
  const isMention = type === "app_mention";
  if (!isDm && !isMention) return { kind: "ignore", reason: "unsupported_event" };
  if (event.subtype !== undefined) return { kind: "ignore", reason: "subtype" };
  // A DM is delivered as message.im; a mention event there would duplicate it.
  if (isMention && typeof event.channel === "string" && event.channel.startsWith("D")) return { kind: "ignore", reason: "unsupported_event" };
  if (event.bot_id !== undefined) return { kind: "ignore", reason: "bot_author" };
  const user = event.user;
  const channel = event.channel;
  const ts = event.ts;
  if (typeof user !== "string" || typeof channel !== "string" || typeof ts !== "string" || !user || !channel || !ts) {
    return { kind: "ignore", reason: "malformed" };
  }
  if (user === context.botUserId) return { kind: "ignore", reason: "self" };
  if (!context.allowedUserIds.has(user)) return { kind: "ignore", reason: "unauthorized" };
  if (typeof event.team === "string" && event.team !== context.teamId) return { kind: "ignore", reason: "identity_mismatch" };

  let text = String(event.text ?? "");
  if (isMention) {
    const mention = `<@${context.botUserId}>`;
    if (!text.includes(mention)) return { kind: "ignore", reason: "not_mentioned" };
    text = text.split(mention).join(" ");
  }
  text = unescapeSlack(text).trim();
  if (!text) return { kind: "ignore", reason: "empty" };
  if (Buffer.byteLength(text, "utf8") > SLACK_MAX_TEXT_BYTES) return { kind: "ignore", reason: "too_large" };
  const [first, ...restWords] = text.split(/\s+/);
  const command = COMMANDS[first.toLowerCase()];
  // Only the exact literal aliases are commands; `!cli` may carry one provider name.
  if (command && (command === "/cli" ? restWords.length <= 1 : restWords.length === 0)) {
    text = restWords.length ? `${command} ${restWords[0]}` : command;
  }

  const threadTs = typeof event.thread_ts === "string" && event.thread_ts ? event.thread_ts : undefined;
  const surfaceIdentity = slackSurfaceIdentity(context.teamId, context.appId);
  // DMs share one session per channel and reply in the originating thread, if any.
  // Channel mentions are scoped to the thread root, which is also where replies go.
  const chatKey = isDm ? channel : `${channel}:${threadTs ?? ts}`;
  const threadId = isDm ? threadTs : (threadTs ?? ts);
  const turn: InteractiveTurnInput = {
    surfaceIdentity,
    chatKey,
    actorId: user,
    messageId: ts,
    text,
    ...(threadId === undefined ? {} : { threadId }),
    conversationScopeId: context.teamId,
    delivery: { chatId: channel, chatType: isDm ? "private" : "supergroup" },
    attachments: [],
  };
  return {
    kind: "turn",
    turn,
    eventId,
    idempotencyKey: `slack:${context.teamId}:${context.appId}:${eventId}`,
    occurredAt: tsToIso(ts),
  };
}

export type SlackAdmission =
  | { kind: "admitted"; receipt: EventReceipt; turn: InteractiveTurnInput }
  | { kind: "duplicate"; receipt: EventReceipt }
  | { kind: "backlog_full" };

/** Persists the minimal recoverable payload. Throws on any storage failure so the caller does not acknowledge. */
export function admitSlackTurn(db: BridgeDb, decision: Extract<SlackAdmissionDecision, { kind: "turn" }>, authorityScope: string): SlackAdmission {
  const existing = db.getEventReceiptByIdempotencyKey(decision.idempotencyKey);
  if (existing) return { kind: "duplicate", receipt: existing };
  if (db.countEventReceipts(SLACK_RECEIPT_SOURCE, "received") >= SLACK_MAX_UNDISPATCHED) return { kind: "backlog_full" };
  const { receipt, created } = db.admitEventReceipt({
    event_id: decision.eventId,
    source: SLACK_RECEIPT_SOURCE,
    event_kind: SLACK_EVENT_KIND,
    idempotency_key: decision.idempotencyKey,
    received_at: new Date().toISOString(),
    occurred_at: decision.occurredAt,
    payload_json: JSON.stringify(decision.turn),
    authority_scope: authorityScope,
  });
  return created ? { kind: "admitted", receipt, turn: decision.turn } : { kind: "duplicate", receipt };
}

export function turnFromReceipt(receipt: EventReceipt): InteractiveTurnInput | null {
  try {
    const value = JSON.parse(receipt.payload_json) as InteractiveTurnInput;
    if (!value?.surfaceIdentity || !value.chatKey || !value.actorId || !value.messageId || !value.delivery?.chatId) return null;
    return value;
  } catch {
    return null;
  }
}
