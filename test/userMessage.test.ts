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


describe("toUserMessage — structured ACP failures", () => {
  it("surfaces ACP data.message instead of bare Internal error", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { message: "You've hit your usage limit. Try again later." },
    });
    expect(toUserMessage(error)).toBe("You've hit your usage limit. Try again later.");
  });

  it("surfaces ACP data.details instead of bare Internal error", () => {
    const error = Object.assign(new Error("RequestError: Internal error"), {
      data: { details: "Could not find default localharness binary. Set ANTIGRAVITY_HARNESS_PATH." },
    });
    expect(toUserMessage(error)).toBe(
      "Could not find default localharness binary. Set ANTIGRAVITY_HARNESS_PATH.",
    );
  });

  it("surfaces actionable detail embedded after a generic ACP wrapper", () => {
    const error = new Error(
      "RequestError: Internal error: Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh",
    );
    expect(toUserMessage(error)).toContain("Failed to refresh OAuth token");
    expect(toUserMessage(error)).not.toBe("RequestError");
  });

  it("uses a bounded transport fallback when no actionable detail exists", () => {
    expect(toUserMessage(new Error("Internal error"))).toBe(
      "Provider connection failed; retry or inspect run diagnostics.",
    );
    expect(toUserMessage(new Error("ACP connection closed"))).toBe(
      "Provider connection failed; retry or inspect run diagnostics.",
    );
    expect(toUserMessage(new Error("RequestError: ACP connection closed"))).toBe(
      "Provider connection failed; retry or inspect run diagnostics.",
    );
  });

  it("preserves auth masking when the actionable text exists only in data.details", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { details: "Authentication required: please log in again." },
    });
    expect(toUserMessage(error)).toBe("Authentication required");
  });

  it("redacts credentials before bounding so truncated secrets cannot leak", () => {
    const previous = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = "secret-boundary-key";
    try {
      const error = Object.assign(new Error("Internal error"), {
        data: { details: `${"x".repeat(1195)}secret-boundary-key` },
      });
      const message = toUserMessage(error);
      expect(message.length).toBeLessThanOrEqual(1200);
      expect(message).not.toContain("secret-");
      expect(message).not.toContain("secret-boundary");
    } finally {
      if (previous === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previous;
    }
  });

  it("redacts configured provider credentials from structured detail", () => {
    const previous = process.env.CODEX_API_KEY;
    process.env.CODEX_API_KEY = "secret-829-key";
    try {
      const error = Object.assign(new Error("Internal error"), {
        data: { details: "provider failed with secret-829-key" },
      });
      expect(toUserMessage(error)).toBe("provider failed with [REDACTED_PROVIDER_CREDENTIAL]");
    } finally {
      if (previous === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = previous;
    }
  });
});
