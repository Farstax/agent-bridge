import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchInteractiveTurnWithFallback } from "../src/interactiveBot.js";
import { SlackClient } from "../src/slack.js";
import { createSlackCliCommandHandler, createSlackReceiptRuntime, SLACK_AMBIGUOUS_NOTICE, SLACK_RESTART_NOTICE } from "../src/slackDispatch.js";
import { admitSlackTurn, classifySlackEnvelope, slackSurfaceIdentity } from "../src/slackIngress.js";
import { acpEngineExec } from "./support/acpEngineExec.js";
import { type as eventType } from "../src/events/types.js";

const SURFACE = slackSurfaceIdentity("T1", "A1");
const ctx = { teamId: "T1", appId: "A1", botUserId: "UBOT", allowedUserIds: new Set(["U1"]) };
const result = (text: string) => [
  JSON.stringify({ type: "text", data: text }),
  JSON.stringify({ type: "end", sessionId: "s-1", stopReason: "end_turn" }),
].join("\n") + "\n";
const body = (event: Record<string, unknown>, eventId: string) => ({ team_id: "T1", api_app_id: "A1", event_id: eventId, event });
const dm = (text: string, ts = "1700000000.000100", extra: Record<string, unknown> = {}) => ({ type: "message", channel_type: "im", channel: "D1", user: "U1", text, ts, ...extra });
const mention = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({ type: "app_mention", channel: "C1", user: "U1", text: `<@UBOT> ${text}`, ts, ...extra });

describe("slack surface through the existing engine (#943)", () => {
  let dir: string;
  let db: ReturnType<typeof openDb>;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-surface-")); db = openDb(join(dir, "bridge.sqlite")); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function harness(options: { post?: (args: any) => Promise<any>; reply?: string } = {}) {
    const posts: any[] = [];
    let counter = 0;
    const web = {
      chat: {
        postMessage: vi.fn(async (args: any) => {
          if (options.post) return options.post(args);
          posts.push(args);
          counter += 1;
          return { ok: true, ts: `1700001000.${String(counter).padStart(6, "0")}`, channel: args.channel };
        }),
      },
    };
    const client = new SlackClient(web as any, { sleep: async () => undefined, channelSpacingMs: 0 });
    const runCli = vi.fn().mockImplementation(async () => result(options.reply ?? "the answer"));
    const engine = new BridgeEngine({
      surfaceIdentity: SURFACE, kind: "grok", botConfig: { command: "grok", modelPreference: [] },
      allowedUserIds: new Set(["U1"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
    }, db, client, acpEngineExec(runCli));
    const chain = new ProviderFallbackChain(["grok"], db, SURFACE, () => true);
    const notices: Array<{ channel: string; thread?: string; text: string }> = [];
    const runtime = createSlackReceiptRuntime({
      db, context: ctx, authorityScope: SURFACE,
      dispatch: (turn) => dispatchInteractiveTurnWithFallback(turn, {
        surfaceIdentity: SURFACE, engines: { grok: engine } as any, fallbackChain: chain, db, notify: async () => undefined,
      }),
      notify: async (channel, thread, text) => { notices.push({ channel, thread, text }); },
    });
    return { runtime, runCli, posts, web, notices, engine };
  }
  const deliver = async (h: ReturnType<typeof harness>, envelope: any) => {
    const ack = vi.fn(async () => undefined);
    await h.runtime.handleEnvelope({ ack, body: envelope });
    return ack;
  };

  it("correlates the receipt to its Run before the provider is invoked", async () => {
    const seen: Array<{ status: string; run_id: string | null }> = [];
    const h = harness();
    h.runCli.mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
      // The ACP runtime emits run.started when the child spawns, before the prompt is submitted.
      options.onEvent?.(eventType.runStarted({ ...options.eventContext, command: "provider", cwd: ".", model: null }));
      const row = db.getEventReceiptByIdempotencyKey("slack:T1:A1:EvPre")!;
      seen.push({ status: row.status, run_id: row.run_id });
      return result("the answer");
    });
    await deliver(h, body(dm("hello"), "EvPre"));
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe("run_created");
    expect(seen[0].run_id).toBeTruthy();
    expect(db.getEventReceiptByIdempotencyKey("slack:T1:A1:EvPre")?.status).toBe("completed");
  });

  it("scrubs the stored message text once the receipt settles", async () => {
    const h = harness();
    await deliver(h, body(dm("super secret request text"), "EvScrub"));
    const row = db.getEventReceiptByIdempotencyKey("slack:T1:A1:EvScrub")!;
    expect(row.status).toBe("completed");
    expect(row.payload_json).toBe("{}");
  });

  it("DM: acknowledges after the receipt, runs once and replies in the DM with native coordinates", async () => {
    const h = harness();
    const ack = await deliver(h, body(dm("hello"), "Ev1"));
    expect(ack).toHaveBeenCalledTimes(1);
    expect(h.runCli).toHaveBeenCalledTimes(1);
    const final = h.posts.find((p) => String(p.text).includes("the answer"));
    expect(final).toMatchObject({ channel: "D1" });
    expect(final).not.toHaveProperty("thread_ts");
    const receipt = db.getEventReceiptByIdempotencyKey("slack:T1:A1:Ev1")!;
    expect(receipt.status).toBe("completed");
    expect(receipt.run_id).toBeTruthy();
    expect(db.getRun(receipt.run_id!)).toMatchObject({ status: "done", surface_identity: SURFACE, chat_id: "D1" });
  });

  it("channel mention: replies in a new thread under the native channel, never the composite key", async () => {
    const h = harness();
    await deliver(h, body(mention("deploy status", "1700000050.000200"), "Ev2"));
    expect(h.runCli).toHaveBeenCalledTimes(1);
    expect(h.posts.length).toBeGreaterThan(0);
    for (const post of h.posts) {
      expect(post.channel).toBe("C1");
      expect(post.thread_ts).toBe("1700000050.000200");
    }
    const receipt = db.getEventReceiptByIdempotencyKey("slack:T1:A1:Ev2")!;
    expect(db.getRun(receipt.run_id!)).toMatchObject({ chat_id: "C1:1700000050.000200" });
  });

  it("a mention inside an existing thread uses that thread's conversation and thread_ts", async () => {
    const h = harness();
    await deliver(h, body(mention("first", "1700000050.000200"), "Ev3"));
    await deliver(h, body(mention("follow up", "1700000060.000300", { thread_ts: "1700000050.000200" }), "Ev4"));
    expect(h.runCli).toHaveBeenCalledTimes(2);
    const runs = ["Ev3", "Ev4"].map((id) => db.getRun(db.getEventReceiptByIdempotencyKey(`slack:T1:A1:${id}`)!.run_id!)!);
    expect(runs[0].chat_id).toBe(runs[1].chat_id);
    expect(h.posts.every((p) => p.thread_ts === "1700000050.000200" && p.channel === "C1")).toBe(true);
  });

  it("redelivery of the same event is acknowledged but never re-executed", async () => {
    const h = harness();
    await deliver(h, body(dm("hello"), "Ev5"));
    const again = await deliver(h, body(dm("hello"), "Ev5"));
    expect(again).toHaveBeenCalledTimes(1);
    expect(h.runCli).toHaveBeenCalledTimes(1);
    expect(db.listEventReceipts("slack", ["completed"])).toHaveLength(1);
  });

  it("ignores unauthorized, unmentioned and foreign-app traffic without a Run or reply", async () => {
    const h = harness();
    await deliver(h, body(dm("hi", "1.1", { user: "U9" }), "Ev6"));
    await deliver(h, body({ type: "message", channel_type: "channel", channel: "C1", user: "U1", text: "hi", ts: "2.2" }, "Ev7"));
    await deliver(h, { ...body(dm("hi"), "Ev8"), api_app_id: "A2" });
    expect(h.runCli).not.toHaveBeenCalled();
    expect(h.web.chat.postMessage).not.toHaveBeenCalled();
    expect(db.listEventReceipts("slack", ["received", "dispatching", "completed"])).toHaveLength(0);
  });

  it("withholds the acknowledgement when no durable receipt can be written", async () => {
    const h = harness();
    db.raw.exec("DROP TABLE event_receipts");
    const ack = await deliver(h, body(dm("hello"), "Ev9"));
    expect(ack).not.toHaveBeenCalled();
    expect(h.runCli).not.toHaveBeenCalled();
  });

  it("an ambiguous final post is never blindly resent and never re-executes the provider", async () => {
    let finals = 0;
    const h = harness({
      post: async (args) => {
        if (String(args.text).includes("the answer")) {
          finals += 1;
          throw Object.assign(new Error("socket hang up"), { code: "slack_webapi_request_error" });
        }
        return { ok: true, ts: "1.1", channel: args.channel };
      },
    });
    await deliver(h, body(dm("hello"), "Ev10"));
    expect(h.runCli).toHaveBeenCalledTimes(1);
    expect(finals).toBe(1);
    // The turn executed and committed; the answer's send outcome is unknown and is not repeated.
    const receipt = db.getEventReceiptByIdempotencyKey("slack:T1:A1:Ev10")!;
    expect(receipt.status).toBe("completed");
    expect(receipt.run_id).toBeTruthy();
    expect(h.runCli).toHaveBeenCalledTimes(1);
  });

  it("restart: a possibly-started receipt is fenced with one native notice and a never-started one runs once", async () => {
    const h = harness();
    const fenced = admitSlackTurn(db, classifySlackEnvelope(body(mention("work", "1700000070.000400"), "EvA"), ctx) as any, SURFACE);
    const fresh = admitSlackTurn(db, classifySlackEnvelope(body(dm("pending work"), "EvB"), ctx) as any, SURFACE);
    if (fenced.kind !== "admitted" || fresh.kind !== "admitted") throw new Error("expected admission");
    db.claimEventReceiptDispatch(fenced.receipt.id); // crashed after the claim, before a terminal state

    await h.runtime.recoverReceipts();
    await h.runtime.recoverReceipts(); // a second recovery pass must be a no-op

    expect(db.getEventReceipt(fenced.receipt.id)?.status).toBe("ambiguous");
    expect(h.notices).toEqual([{ channel: "C1", thread: "1700000070.000400", text: SLACK_RESTART_NOTICE }]);
    expect(h.runCli).toHaveBeenCalledTimes(1);
    expect(db.getEventReceipt(fresh.receipt.id)?.status).toBe("completed");
    expect(String(h.posts.at(-1)?.text)).toContain("the answer");
  });

  it("restart: work the durable queue still owns is left to queue recovery and is never fenced or re-notified", async () => {
    const h = harness();
    const first = admitSlackTurn(db, classifySlackEnvelope(body(dm("first"), "EvQ1"), ctx) as any, SURFACE);
    const queued = admitSlackTurn(db, classifySlackEnvelope(body(dm("second", "1700000100.000500"), "EvQ2"), ctx) as any, SURFACE);
    if (first.kind !== "admitted" || queued.kind !== "admitted") throw new Error("expected admission");
    db.claimEventReceiptDispatch(first.receipt.id);
    db.claimEventReceiptDispatch(queued.receipt.id);
    // The second message was persisted by the engine's durable queue with its receipt correlation.
    db.enqueueMsg(SURFACE, "D1", {
      prompt: "second", chatId: "D1", chatType: "private", userId: "U1", attachments: [],
      scheduledOccurrenceKey: `event-receipt:${queued.receipt.id}`,
    });

    await h.runtime.recoverReceipts();

    expect(db.getEventReceipt(first.receipt.id)?.status).toBe("ambiguous");
    expect(db.getEventReceipt(queued.receipt.id)?.status).toBe("dispatching");
    expect(h.notices).toHaveLength(1);
    expect(h.runCli).not.toHaveBeenCalled();
    // The engine's queue recovery then executes it and settles the receipt.
    await h.engine.recoverPendingQueues();
    const settled = db.getEventReceipt(queued.receipt.id)!;
    expect(settled.status).toBe("completed");
    expect(settled.run_id).toBeTruthy();
    expect(h.runCli).toHaveBeenCalledTimes(1);
  });

  it("restart: a receipt linked to a Run is fenced without a second notice", async () => {
    const h = harness();
    const admitted = admitSlackTurn(db, classifySlackEnvelope(body(dm("work"), "EvL"), ctx) as any, SURFACE);
    if (admitted.kind !== "admitted") throw new Error("expected admission");
    db.claimEventReceiptDispatch(admitted.receipt.id);
    db.insertRun("run-live", { surfaceIdentity: SURFACE, chatKey: "D1" }, "grok");
    db.linkEventReceiptRun(admitted.receipt.id, "run-live");
    await h.runtime.recoverReceipts();
    expect(db.getEventReceipt(admitted.receipt.id)).toMatchObject({ status: "ambiguous", run_id: "run-live" });
    expect(h.notices).toHaveLength(0);
    expect(h.runCli).not.toHaveBeenCalled();
  });

  it("retains settled receipts only for the retention window", async () => {
    const h = harness();
    await deliver(h, body(dm("old"), "EvOld"));
    db.raw.prepare("UPDATE event_receipts SET received_at = ? WHERE idempotency_key = ?").run("2020-01-01T00:00:00.000Z", "slack:T1:A1:EvOld");
    await deliver(h, body(dm("new", "1700000200.000100"), "EvNew"));
    await h.runtime.recoverReceipts();
    expect(db.getEventReceiptByIdempotencyKey("slack:T1:A1:EvOld")).toBeNull();
    expect(db.getEventReceiptByIdempotencyKey("slack:T1:A1:EvNew")).not.toBeNull();
  });

  it("!cli switches or reports the provider without creating a Run", async () => {
    const h = harness();
    const chain = new ProviderFallbackChain(["grok", "codex"], db, SURFACE, () => true);
    const sent: string[] = [];
    const handler = createSlackCliCommandHandler({
      db, surfaceIdentity: SURFACE, fallbackChain: chain,
      available: () => new Set(["grok", "codex"]) as any, hasEngine: (cli) => cli === "grok" || cli === "codex",
      notify: async (_c, _t, text) => { sent.push(text); },
    });
    const runtime = createSlackReceiptRuntime({
      db, context: ctx, authorityScope: SURFACE, handleCommand: handler,
      dispatch: async () => { throw new Error("must not execute"); }, notify: async () => undefined,
    });
    const ack = vi.fn(async () => undefined);
    await runtime.handleEnvelope({ ack, body: body(dm("!cli codex"), "EvCli1") });
    await runtime.handleEnvelope({ ack, body: body(dm("!cli", "1700000300.000100"), "EvCli2") });
    await runtime.handleEnvelope({ ack, body: body(dm("!cli nonsense", "1700000400.000100"), "EvCli3") });
    expect(sent[0]).toContain("Active CLI: **codex**");
    expect(sent[1]).toContain("Active CLI: **codex**");
    expect(sent[2]).toMatch(/Unknown or unavailable CLI/);
    expect(db.listEventReceipts("slack", ["completed"])).toHaveLength(3);
    expect(h.runCli).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM bridge_runs").get()).toEqual({ n: 0 });
  });

  it("a dispatch that throws fences the receipt and notifies once instead of replaying", async () => {
    const h = harness();
    const dispatchSpy = vi.fn(async () => { throw new Error("boom"); });
    const runtime = createSlackReceiptRuntime({
      db, context: ctx, authorityScope: SURFACE, dispatch: dispatchSpy, notify: async (c, t, text) => { h.notices.push({ channel: c, thread: t, text }); },
    });
    const ack = vi.fn(async () => undefined);
    await runtime.handleEnvelope({ ack, body: body(dm("hello"), "Ev11") });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(db.getEventReceiptByIdempotencyKey("slack:T1:A1:Ev11")?.status).toBe("ambiguous");
    expect(h.notices).toEqual([{ channel: "D1", thread: undefined, text: SLACK_AMBIGUOUS_NOTICE }]);
    await runtime.recoverReceipts();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("slack scheduled routines (#943)", () => {
  it("creates a routine for a channel thread and dispatches with the stored native coordinates", async () => {
    const { createScheduledRoutine, buildScheduledInteractiveTurn } = await import("../src/scheduledRoutines.js");
    const dir = mkdtempSync(join(tmpdir(), "slack-routine-"));
    const db = openDb(join(dir, "bridge.sqlite"));
    try {
      const created = createScheduledRoutine(db, {
        id: "r1", name: "daily", surfaceIdentity: SURFACE, chatKey: "C1:1700000050.000200", ownerKey: "owner", kind: "companion",
        timezone: "UTC", schedule: { type: "weekly", weekdays: [1], time: "09:00" }, instruction: "do it", enabled: true,
        createdAt: new Date().toISOString(),
      });
      expect(created.delivery).toEqual({ chatId: "C1", chatType: "supergroup", threadId: "1700000050.000200" });
      const turn = buildScheduledInteractiveTurn(created, new Date().toISOString(), "U1");
      expect(turn).toMatchObject({ chatKey: "C1:1700000050.000200", threadId: "1700000050.000200", delivery: { chatId: "C1", chatType: "supergroup" } });
      const dmRoutine = createScheduledRoutine(db, { ...created, id: "r2", chatKey: "D1", delivery: undefined });
      expect(dmRoutine.delivery).toEqual({ chatId: "D1", chatType: "private" });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
