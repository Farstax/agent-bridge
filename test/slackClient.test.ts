import { describe, expect, it, vi } from "vitest";
import { SlackClient, SlackDeliveryError, chunkSlackText, escapeSlackText } from "../src/slack.js";
import { SLACK_SURFACE_CAPABILITIES, surfaceCapabilities, parseSurfaceIdentity } from "../src/platform.js";

function web(impl: (args: any) => Promise<any>) {
  const postMessage = vi.fn(impl);
  return { chat: { postMessage }, postMessage };
}
const ok = (ts = "1700000000.000100") => async () => ({ ok: true, ts, channel: "C1" });
const platformError = (error: string) => Object.assign(new Error(error), { code: "slack_webapi_platform_error", data: { ok: false, error } });
const rateLimited = (retryAfter = 1) => Object.assign(new Error("rl"), { code: "slack_webapi_rate_limited_error", retryAfter });
const requestError = () => Object.assign(new Error("socket hang up"), { code: "slack_webapi_request_error" });
const httpError = (statusCode: number) => Object.assign(new Error("http"), { code: "slack_webapi_http_error", statusCode });
const fast = { sleep: async () => undefined, channelSpacingMs: 0 };

describe("slack transport adapter (#943)", () => {
  it("advertises only what it supports", () => {
    expect(surfaceCapabilities(new SlackClient(web(ok()) as any))).toEqual(SLACK_SURFACE_CAPABILITIES);
    expect(SLACK_SURFACE_CAPABILITIES).toMatchObject({
      formatting: "plain", threads: true, previewStreaming: false, typing: false, attachments: false,
      richMessages: false, passiveSurroundingContext: false, polling: false, editMessages: false, deleteMessages: false,
    });
    expect(parseSurfaceIdentity("slack:T1:A1")).toEqual({ kind: "slack", accountId: "T1:A1" });
  });

  it("posts to the native channel and thread with unfurl off and returns the opaque ts", async () => {
    const w = web(ok("1700000005.000900"));
    const client = new SlackClient(w as any, fast);
    const result = await client.sendMessage({ chat_id: "C1", message_thread_id: "1700000000.000100", text: "hi <@U9> & <!channel>" });
    expect(w.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1", thread_ts: "1700000000.000100", unfurl_links: false, unfurl_media: false, mrkdwn: false,
      text: "hi &lt;@U9&gt; &amp; &lt;!channel&gt;",
    }));
    expect(result).toMatchObject({ ok: true, id: "1700000005.000900", ts: "1700000005.000900" });
    expect(typeof result.id).toBe("string");
  });

  it("omits thread_ts for a top-level DM reply", async () => {
    const w = web(ok());
    await new SlackClient(w as any, fast).sendMessage({ chat_id: "D1", text: "hi" });
    expect(w.postMessage.mock.calls[0][0]).not.toHaveProperty("thread_ts");
  });

  it("escapes control sequences", () => {
    expect(escapeSlackText("<!here> <@U1> <http://x|y> a&b")).toBe("&lt;!here&gt; &lt;@U1&gt; &lt;http://x|y&gt; a&amp;b");
  });

  it("chunks long text at or below 3,500 characters preferring line boundaries", () => {
    const text = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;
    const chunks = chunkSlackText(text);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 3500)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });

  it("posts chunks in order and reports how many were delivered when a later chunk fails", async () => {
    let call = 0;
    const w = web(async () => { call += 1; if (call === 2) throw requestError(); return { ok: true, ts: `${call}.0`, channel: "C1" }; });
    const client = new SlackClient(w as any, fast);
    const error = await client.sendMessage({ chat_id: "C1", text: "x".repeat(8000) }).catch((e) => e);
    expect(error).toBeInstanceOf(SlackDeliveryError);
    expect(error.finalChunksDelivered).toBe(1);
    expect(error.status).toBeUndefined();
    expect(w.postMessage).toHaveBeenCalledTimes(2);
  });

  it("retries only a confirmed 429, bounded, honouring Retry-After", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const w = web(async () => { call += 1; if (call < 3) throw rateLimited(2); return { ok: true, ts: "9.9", channel: "C1" }; });
    const client = new SlackClient(w as any, { sleep: async (ms) => { sleeps.push(ms); }, channelSpacingMs: 0, now: () => 0 });
    await expect(client.sendMessage({ chat_id: "C1", text: "hi" })).resolves.toMatchObject({ id: "9.9" });
    expect(w.postMessage).toHaveBeenCalledTimes(3);
    expect(sleeps.filter((ms) => ms > 0).every((ms) => ms === 2000)).toBe(true);

    const always = web(async () => { throw rateLimited(1); });
    const error = await new SlackClient(always as any, fast).sendMessage({ chat_id: "C1", text: "hi" }).catch((e) => e);
    expect(error.status).toBe(429);
    expect(always.postMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["network error", requestError()],
    ["HTTP 408", httpError(408)],
    ["HTTP 500", httpError(500)],
    ["HTTP 503", httpError(503)],
  ])("never retries or marks retryable an ambiguous %s", async (_name, failure) => {
    const w = web(async () => { throw failure; });
    const error = await new SlackClient(w as any, fast).sendMessage({ chat_id: "C1", text: "hi" }).catch((e) => e);
    expect(w.postMessage).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(SlackDeliveryError);
    expect(error.outcome).toBe("ambiguous");
    expect(error.status).toBeUndefined();
  });

  it("treats an ok:false platform answer as a definite, non-retryable rejection", async () => {
    const w = web(async () => { throw platformError("channel_not_found"); });
    const error = await new SlackClient(w as any, fast).sendMessage({ chat_id: "C1", text: "hi" }).catch((e) => e);
    expect(error).toMatchObject({ outcome: "rejected", slackCode: "channel_not_found" });
    expect(error.status).toBeUndefined();
    expect(w.postMessage).toHaveBeenCalledTimes(1);
  });

  it("treats a response without ts as ambiguous", async () => {
    const w = web(async () => ({ ok: true }));
    const error = await new SlackClient(w as any, fast).sendMessage({ chat_id: "C1", text: "hi" }).catch((e) => e);
    expect(error.outcome).toBe("ambiguous");
  });

  it("serialises posts per channel and paces them", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const order: string[] = [];
    const w = web(async (args) => {
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1; order.push(args.text);
      return { ok: true, ts: "1.1", channel: args.channel };
    });
    const client = new SlackClient(w as any, fast);
    await Promise.all([1, 2, 3].map((n) => client.sendMessage({ chat_id: "C1", text: `m${n}` })));
    expect(maxInflight).toBe(1);
    expect(order).toEqual(["m1", "m2", "m3"]);
    let t = 0;
    const slept: number[] = [];
    const paced = new SlackClient(web(ok()) as any, { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, channelSpacingMs: 1000 });
    await paced.sendMessage({ chat_id: "C1", text: "a" });
    await paced.sendMessage({ chat_id: "C1", text: "b" });
    expect(slept).toEqual([1000]);
  });

  it("fails explicitly for unsupported operations", async () => {
    const client = new SlackClient(web(ok()) as any, fast);
    await expect(client.editMessageText({})).rejects.toThrow(/does not support/);
    await expect(client.deleteMessage({})).rejects.toThrow(/does not support/);
    await expect(client.answerCallbackQuery({})).rejects.toThrow(/does not support/);
    await expect(client.sendDocument()).rejects.toThrow(/does not support/);
    await expect(client.sendPhoto()).rejects.toThrow(/does not support/);
  });
});
