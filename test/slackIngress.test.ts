import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import {
  SLACK_MAX_TEXT_BYTES,
  SLACK_MAX_UNDISPATCHED,
  admitSlackTurn,
  classifySlackEnvelope,
  slackSurfaceIdentity,
  turnFromReceipt,
  type SlackVerifiedContext,
} from "../src/slackIngress.js";

const ctx: SlackVerifiedContext = { teamId: "T1", appId: "A1", botUserId: "UBOT", allowedUserIds: new Set(["U1"]) };

function envelope(event: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { team_id: "T1", api_app_id: "A1", event_id: "Ev1", event, ...overrides };
}
const dm = (extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "im", channel: "D1", user: "U1", text: "hello", ts: "1700000000.000100", ...extra });
const mention = (extra: Record<string, unknown> = {}) => ({ type: "app_mention", channel: "C1", user: "U1", text: "<@UBOT> hello", ts: "1700000001.000200", ...extra });

describe("slack event classification (#943)", () => {
  it("normalises a DM with native channel coordinates and the shared DM session", () => {
    const d = classifySlackEnvelope(envelope(dm()), ctx);
    expect(d.kind).toBe("turn");
    if (d.kind !== "turn") return;
    expect(d.turn).toMatchObject({
      surfaceIdentity: "slack:T1:A1", chatKey: "D1", actorId: "U1", messageId: "1700000000.000100", text: "hello",
      delivery: { chatId: "D1", chatType: "private" },
    });
    expect(d.turn.threadId).toBeUndefined();
    expect(d.idempotencyKey).toBe("slack:T1:A1:Ev1");
  });

  it("keeps the thread of a threaded DM without changing the session", () => {
    const d = classifySlackEnvelope(envelope(dm({ thread_ts: "1699999999.000001" })), ctx);
    if (d.kind !== "turn") throw new Error("expected turn");
    expect(d.turn.chatKey).toBe("D1");
    expect(d.turn.threadId).toBe("1699999999.000001");
  });

  it("scopes a root channel mention to a new thread and never uses the composite key as the channel", () => {
    const d = classifySlackEnvelope(envelope(mention()), ctx);
    if (d.kind !== "turn") throw new Error("expected turn");
    expect(d.turn.chatKey).toBe("C1:1700000001.000200");
    expect(d.turn.threadId).toBe("1700000001.000200");
    expect(d.turn.delivery.chatId).toBe("C1");
    expect(d.turn.text).toBe("hello");
  });

  it("maps a mention inside an existing thread to that thread's conversation and thread_ts", () => {
    const d = classifySlackEnvelope(envelope(mention({ thread_ts: "1700000000.000100" })), ctx);
    if (d.kind !== "turn") throw new Error("expected turn");
    expect(d.turn.chatKey).toBe("C1:1700000000.000100");
    expect(d.turn.threadId).toBe("1700000000.000100");
  });

  it.each([
    ["unauthorized user", envelope(dm({ user: "U9" })), "unauthorized"],
    ["bot author", envelope(dm({ bot_id: "B1" })), "bot_author"],
    ["the bot itself", envelope(dm({ user: "UBOT" })), "self"],
    ["edit", envelope(dm({ subtype: "message_changed" })), "subtype"],
    ["deletion", envelope(dm({ subtype: "message_deleted" })), "subtype"],
    ["unmentioned channel message", envelope({ type: "message", channel_type: "channel", channel: "C1", user: "U1", text: "hi", ts: "1.1" }), "unsupported_event"],
    ["group DM", envelope(dm({ channel_type: "mpim" })), "unsupported_event"],
    ["mention of another user", envelope(mention({ text: "<@UOTHER> hi" })), "not_mentioned"],
    ["wrong team", envelope(dm(), { team_id: "T2" }), "identity_mismatch"],
    ["wrong app", envelope(dm(), { api_app_id: "A2" }), "identity_mismatch"],
    ["enterprise install", envelope(dm(), { is_enterprise_install: true }), "enterprise_install"],
    ["shared channel", envelope(mention(), { is_ext_shared_channel: true }), "enterprise_install"],
    ["empty text", envelope(dm({ text: "   " })), "empty"],
    ["missing event id", { team_id: "T1", api_app_id: "A1", event: dm() }, "malformed"],
    ["oversize text", envelope(dm({ text: "x".repeat(SLACK_MAX_TEXT_BYTES + 1) })), "too_large"],
  ])("ignores %s", (_name, body, reason) => {
    expect(classifySlackEnvelope(body, ctx)).toEqual({ kind: "ignore", reason });
  });

  it("maps only the literal command aliases and only as the first token", () => {
    const text = (value: string, base = dm) => {
      const d = classifySlackEnvelope(envelope(base({ text: value })), ctx);
      if (d.kind !== "turn") throw new Error("expected turn");
      return d.turn.text;
    };
    expect(text("!stop")).toBe("/stop");
    expect(text("!reset")).toBe("/reset");
    expect(text("!cancel")).toBe("/cancel");
    expect(text("!cli codex")).toBe("/cli codex");
    expect(text("!cli")).toBe("/cli");
    // Anything beyond the literal alias is ordinary text, never a command.
    expect(text("!stop please")).toBe("!stop please");
    expect(text("!reset the nginx config and retry")).toBe("!reset the nginx config and retry");
    expect(text("!cli codex now")).toBe("!cli codex now");
    expect(text("<@UBOT> !stop", mention)).toBe("/stop");
    expect(text("please !stop")).toBe("please !stop");
    expect(text("/stop")).toBe("/stop"); // never an alias: Slack reserves slash commands
    expect(text("!stopnow")).toBe("!stopnow");
  });

  it("does not treat a DM mention event as a second delivery of the DM", () => {
    const d = classifySlackEnvelope(envelope({ type: "app_mention", channel: "D1", user: "U1", text: "<@UBOT> hi", ts: "1.1" }), ctx);
    expect(d).toEqual({ kind: "ignore", reason: "unsupported_event" });
  });

  it("decodes Slack entity escaping and strips only the bot mention", () => {
    const d = classifySlackEnvelope(envelope(mention({ text: "<@UBOT> a &lt;b&gt; &amp; <@UOTHER>" })), ctx);
    if (d.kind !== "turn") throw new Error("expected turn");
    expect(d.turn.text).toBe("a <b> & <@UOTHER>");
  });

  it("builds the surface identity from verified team and app", () => {
    expect(slackSurfaceIdentity("T1", "A1")).toBe("slack:T1:A1");
  });
});

describe("slack durable admission (#943)", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-ingress-")); db = openDb(join(dir, "bridge.sqlite")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  const turnDecision = (eventId = "Ev1", event = dm()) => {
    const d = classifySlackEnvelope(envelope(event, { event_id: eventId }), ctx);
    if (d.kind !== "turn") throw new Error("expected turn");
    return d;
  };

  it("persists a recoverable receipt and reports a redelivery of the same event_id as duplicate", () => {
    const first = admitSlackTurn(db, turnDecision(), "slack:T1:A1");
    expect(first.kind).toBe("admitted");
    const again = admitSlackTurn(db, turnDecision("Ev1"), "slack:T1:A1");
    expect(again.kind).toBe("duplicate");
    expect(db.listEventReceipts("slack", ["received"])).toHaveLength(1);
    if (first.kind !== "admitted") return;
    expect(turnFromReceipt(first.receipt)).toMatchObject({ chatKey: "D1", delivery: { chatId: "D1" } });
  });

  it("keys on event_id, so a different envelope for the same event is still a duplicate", () => {
    admitSlackTurn(db, turnDecision("Ev7"), "slack:T1:A1");
    const redelivery = admitSlackTurn(db, turnDecision("Ev7"), "slack:T1:A1");
    expect(redelivery.kind).toBe("duplicate");
  });

  it("lets exactly one claimant dispatch a receipt", () => {
    const admitted = admitSlackTurn(db, turnDecision(), "slack:T1:A1");
    if (admitted.kind !== "admitted") throw new Error("expected admitted");
    expect(db.claimEventReceiptDispatch(admitted.receipt.id)).toBe(true);
    expect(db.claimEventReceiptDispatch(admitted.receipt.id)).toBe(false);
  });

  it("refuses admission once the undispatched backlog is full so the envelope is not acknowledged", () => {
    for (let i = 0; i < SLACK_MAX_UNDISPATCHED; i += 1) admitSlackTurn(db, turnDecision(`Ev${i}`), "slack:T1:A1");
    expect(admitSlackTurn(db, turnDecision("EvOver"), "slack:T1:A1").kind).toBe("backlog_full");
  });

  it("throws on a storage failure so the caller withholds the acknowledgement", () => {
    db.raw.exec("DROP TABLE event_receipts");
    expect(() => admitSlackTurn(db, turnDecision(), "slack:T1:A1")).toThrow();
  });

  it("links a Run once and keeps terminal receipts immutable", () => {
    const admitted = admitSlackTurn(db, turnDecision(), "slack:T1:A1");
    if (admitted.kind !== "admitted") throw new Error("expected admitted");
    const id = admitted.receipt.id;
    db.claimEventReceiptDispatch(id);
    db.insertRun("run-1", { surfaceIdentity: "slack:T1:A1", chatKey: "D1" }, "codex");
    db.linkEventReceiptRun(id, "run-1");
    expect(db.getEventReceipt(id)).toMatchObject({ status: "run_created", run_id: "run-1" });
    db.finishEventReceipt(id, { status: "completed", result_reference: "run-1" });
    db.finishEventReceipt(id, { status: "failed" });
    expect(db.getEventReceipt(id)?.status).toBe("completed");
    db.insertRun("run-2", { surfaceIdentity: "slack:T1:A1", chatKey: "D1" }, "codex");
    db.linkEventReceiptRun(id, "run-2");
    expect(db.getEventReceipt(id)?.run_id).toBe("run-1");
  });
});
