import { describe, expect, it } from "vitest";
import { toUserMessage } from "../src/cli.js";

const UPSTREAM_USAGE_LIMIT_STDOUT = [
  '{"type":"thread.started","thread_id":"019e4f38-0522-72a1-bdd9-672beebf9c34"}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:40 PM."}',
  '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:40 PM."}}',
].join("\n");

describe("toUserMessage — structured upstream error extraction", () => {
  it("surfaces the upstream message from turn.failed payloads", () => {
    const err = new Error(`CLI exited with code 1: ${UPSTREAM_USAGE_LIMIT_STDOUT}`);
    expect(toUserMessage(err)).toBe(
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 11:40 PM.",
    );
  });

  it("falls back to the type=error message when no turn.failed line is present", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"error","message":"Quota exceeded"}',
    ].join("\n");
    const err = new Error(`CLI exited with code 1: ${stdout}`);
    expect(toUserMessage(err)).toBe("Quota exceeded");
  });
});

describe("toUserMessage — Claude JSON extraction", () => {
  it("surfaces the rate limit message from is_error: true result payloads", () => {
    const stdout = '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You\'ve hit your limit · resets 2:40am (Europe/London)"}';
    const err = new Error(`CLI exited with code 1: ${stdout}`);
    expect(toUserMessage(err)).toBe("You've hit your limit · resets 2:40am (Europe/London)");
  });
});

describe("toUserMessage — Antigravity JSON error extraction", () => {
  it("surfaces the error message from Agy log errors", () => {
    const innerMsg = "agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached.";
    const err = new Error(JSON.stringify({ type: "error", message: innerMsg }));
    expect(toUserMessage(err)).toBe(innerMsg);
  });

  it("surfaces empty response errors", () => {
    const err = new Error(JSON.stringify({ type: "error", message: "Agy execution returned empty response" }));
    expect(toUserMessage(err)).toBe("Agy execution returned empty response");
  });
});

describe("toUserMessage — plain errors", () => {
  it("keeps the existing behavior for non-JSON errors", () => {
    const err = new Error("CLI hard timeout after 600000ms");
    expect(toUserMessage(err)).toBe("CLI hard timeout after 600000ms");
  });

  it("strips the prefix only when no upstream message is embedded", () => {
    const err = new Error("Some failure: details");
    expect(toUserMessage(err)).toBe("Some failure");
  });
});
