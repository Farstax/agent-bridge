import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  SlackIdentityError,
  VerifiedSocketModeClient,
  assertSupportedSlackTokens,
  verifySlackBotIdentity,
} from "../src/slackIdentity.js";

const web = (auth: any, info: any) => ({
  auth: { test: vi.fn(async () => { if (auth instanceof Error) throw auth; return auth; }) },
  bots: { info: vi.fn(async () => { if (info instanceof Error) throw info; return info; }) },
});

describe("slack bot identity (#943)", () => {
  it("derives team, bot user and app from auth.test and bots.info", async () => {
    const w = web({ team_id: "T1", user_id: "UBOT", bot_id: "B1" }, { bot: { app_id: "A1" } });
    await expect(verifySlackBotIdentity(w)).resolves.toEqual({ teamId: "T1", botUserId: "UBOT", botId: "B1", appId: "A1" });
    expect(w.bots.info).toHaveBeenCalledWith({ bot: "B1" });
  });

  it.each([
    ["auth.test failure", web(new Error("invalid_auth"), {}), "token_invalid"],
    ["missing bot id", web({ team_id: "T1", user_id: "U" }, {}), "identity_unavailable"],
    ["bots.info failure", web({ team_id: "T1", user_id: "U", bot_id: "B" }, new Error("missing_scope")), "identity_unavailable"],
    ["missing app id", web({ team_id: "T1", user_id: "U", bot_id: "B" }, { bot: {} }), "identity_unavailable"],
  ])("fails closed on %s", async (_n, w, code) => {
    await expect(verifySlackBotIdentity(w as any)).rejects.toMatchObject({ code });
  });

  it("distinguishes permanent credential failures from transient transport failures", async () => {
    const platform = (error: string) => Object.assign(new Error(error), { code: "slack_webapi_platform_error", data: { ok: false, error } });
    const transient = Object.assign(new Error("hang up"), { code: "slack_webapi_request_error" });
    await expect(verifySlackBotIdentity(web(platform("invalid_auth"), {}) as any)).rejects.toMatchObject({ permanent: true });
    await expect(verifySlackBotIdentity(web(platform("token_revoked"), {}) as any)).rejects.toMatchObject({ permanent: true });
    await expect(verifySlackBotIdentity(web(transient, {}) as any)).rejects.toMatchObject({ permanent: false });
    await expect(verifySlackBotIdentity(web(platform("ratelimited"), {}) as any)).rejects.toMatchObject({ permanent: false });
    await expect(verifySlackBotIdentity(web({ team_id: "T", user_id: "U", bot_id: "B" }, platform("missing_scope")) as any)).rejects.toMatchObject({ permanent: true });
  });

  it("rejects expiring token families and malformed tokens with actionable errors", () => {
    expect(() => assertSupportedSlackTokens("xoxe.xoxb-1-abc", "xapp-1-x")).toThrow(SlackIdentityError);
    expect(() => assertSupportedSlackTokens("xoxe.xoxb-1-abc", "xapp-1-x")).toThrow(/rotat/i);
    expect(() => assertSupportedSlackTokens("xoxb-1-abc", "xoxe.xapp-1-x")).toThrow(/rotat/i);
    expect(() => assertSupportedSlackTokens("xoxp-1", "xapp-1-x")).toThrow(/bot token/);
    expect(() => assertSupportedSlackTokens("xoxb-1-abc", "xoxb-2")).toThrow(/app-level/);
    expect(() => assertSupportedSlackTokens("xoxb-1-abc", "xapp-1-x")).not.toThrow();
  });
});

/**
 * Contract pin: identity binding relies on the SDK's protected, bound
 * `ws_message` handler. These tests fail on an incompatible SDK upgrade.
 */
describe("Socket Mode hello binding (#943)", () => {
  function client(expectedAppId = "A1") {
    const hooks = { onVerified: vi.fn(), onRejected: vi.fn() };
    const c = new VerifiedSocketModeClient({ appToken: "xapp-1-test", autoReconnectEnabled: true }, expectedAppId, hooks);
    const connected = vi.fn();
    const events: any[] = [];
    c.on("connected", connected);
    c.on("app_mention", (e: any) => events.push(e));
    c.on("message", (e: any) => events.push(e));
    return { c, hooks, connected, events };
  }
  const hello = (appId?: string) => JSON.stringify({ type: "hello", connection_info: appId === undefined ? {} : { app_id: appId }, num_connections: 1 });
  const eventsApi = JSON.stringify({ type: "events_api", envelope_id: "e1", payload: { event: { type: "message" }, event_id: "Ev1" } });
  const emit = async (c: any, data: string) => { c.emit("ws_message", data, false); await new Promise((r) => setImmediate(r)); };

  it("binds to the SDK's overridable handler and still emits connected after a matching hello", async () => {
    const { c, hooks, connected } = client();
    await emit(c, hello("A1"));
    expect(hooks.onVerified).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(c.socketVerified).toBe(true);
  });

  it("drops envelopes that arrive before a verified hello", async () => {
    const { c, events } = client();
    await emit(c, eventsApi);
    expect(events).toHaveLength(0);
  });

  it("dispatches envelopes only after the hello proved the app", async () => {
    const { c, events } = client();
    await emit(c, hello("A1"));
    await emit(c, eventsApi);
    expect(events).toHaveLength(1);
  });

  it.each([
    ["a different app", "A2", "app_mismatch"],
    ["no app id", undefined, "app_unverified"],
  ])("refuses a hello with %s, disables reconnect and serves nothing", async (_n, appId, code) => {
    const { c, hooks, connected, events } = client();
    await emit(c, hello(appId));
    expect(hooks.onRejected).toHaveBeenCalledWith(code);
    expect(connected).not.toHaveBeenCalled();
    expect((c as any).autoReconnectEnabled).toBe(false);
    await emit(c, eventsApi);
    expect(events).toHaveLength(0);
  });

  it("requires a fresh proof after the socket closes", async () => {
    const { c, events } = client();
    await emit(c, hello("A1"));
    expect(c.socketVerified).toBe(true);
    c.emit("close");
    expect(c.socketVerified).toBe(false);
    await emit(c, eventsApi);
    expect(events).toHaveLength(0);
  });

  it("pins the SDK internals this binding depends on", () => {
    const source = readFileSync(new URL("../node_modules/@slack/socket-mode/dist/src/SocketModeClient.js", import.meta.url), "utf8");
    expect(source).toContain("this.on('ws_message', this.onWebSocketMessage.bind(this))");
    expect(source).toMatch(/event\.type === 'hello'/);
    expect(source).toMatch(/this\.emit\(State\.Connected, this\.connectionResponse\)/);
    expect(JSON.parse(readFileSync(new URL("../node_modules/@slack/socket-mode/package.json", import.meta.url), "utf8")).version).toBe("3.1.0");
  });
});
