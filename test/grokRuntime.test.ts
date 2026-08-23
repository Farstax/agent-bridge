import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";
import { getProviderAdapter, PROVIDER_IDS, resolveProviderExecutable } from "../src/providers/registry.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { loadBotsConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

function grokStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("grok provider registration", () => {
  it("registers grok as an explicit opt-in provider", () => {
    expect(PROVIDER_IDS).toContain("grok");
    const adapter = getProviderAdapter("grok");
    expect(adapter.displayName).toBe("Grok Build");
    expect(adapter.executable).toBe("grok");
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.fallbackTarget).toBe(false);
    expect(adapter.capabilities.toolFree).toBe(false);
  });

  it("resolves a configurable grok executable instead of a generic agent binary", () => {
    expect(resolveProviderExecutable("grok", {})).toBe("grok");
    expect(resolveProviderExecutable("grok", { GROK_COMMAND: "/opt/xai/bin/grok" })).toBe("/opt/xai/bin/grok");
    expect(loadBotsConfig({}).grok.command).toBe("grok");
    expect(loadBotsConfig({ GROK_COMMAND: "/usr/local/bin/grok" }).grok.command).toBe("/usr/local/bin/grok");
  });

  it("keeps grok out of production fallback defaults", () => {
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "antigravity"],
    })).toEqual(["codex", "claude", "antigravity"]);
    expect(interactiveChainKinds()).toContain("grok");
    expect(parseCliChain("grok", {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "antigravity"],
    })).toEqual(["grok"]);
  });
});

describe("grok invocation", () => {
  it("builds a fresh headless streaming-json invocation", () => {
    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "hello",
      sessionId: null,
      command: "/opt/xai/bin/grok",
      includeResponseContract: false,
    });
    expect(invocation.command).toBe("/opt/xai/bin/grok");
    expect(invocation.nativeSessionMode).toBe("fresh");
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("hello");
    expect(invocation.args.slice(2)).toEqual(["--output-format", "streaming-json"]);
  });

  it("resumes with the native session id", () => {
    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "continue",
      sessionId: "sess-abc",
      command: "grok",
      includeResponseContract: false,
    });
    expect(invocation.nativeSessionMode).toBe("resume");
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("continue");
    expect(invocation.args.slice(2)).toEqual([
      "--output-format", "streaming-json",
      "--resume", "sess-abc",
    ]);
  });

  it("adds trusted auto-approval and model selection without a generic agent alias", () => {
    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "edit files",
      sessionId: null,
      command: "grok",
      model: "grok-4.5",
      executionMode: "trusted",
      includeResponseContract: false,
    });
    expect(invocation.args[0]).toBe("-p");
    expect(invocation.args[1]).toContain("edit files");
    expect(invocation.args.slice(2)).toEqual([
      "--output-format", "streaming-json",
      "--model", "grok-4.5",
      "--always-approve",
    ]);
  });

  it("rejects tool-free mode until a native contract is proven", () => {
    expect(() => buildCliInvocation({
      bot: "grok",
      prompt: "hi",
      sessionId: null,
      command: "grok",
      toolMode: "none",
    })).toThrow(/Tool-free mode is not supported for grok/);
  });
});

describe("grok streaming-json parser", () => {
  it("emits only text.data and retains end.sessionId", () => {
    const result = parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "thought", data: "I should hide this" },
        { type: "tool_call", toolCallId: "t1", toolName: "shell", rawInput: { command: "cat secret" } },
        { type: "text", data: "Hello " },
        { type: "usage", input_tokens: 12 },
        { type: "text", data: "world" },
        { type: "end", stopReason: "end_turn", sessionId: "sess-1" },
      ]),
    });
    expect(result.text).toBe("Hello world");
    expect(result.sessionId).toBe("sess-1");
    expect(result.text).not.toContain("hide");
    expect(result.text).not.toContain("secret");
  });

  it("excludes thought, tool, command, usage, permission, protocol, and error content from the answer", () => {
    const result = parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "thought", data: "secret-thought" },
        { type: "tool", data: "secret-tool" },
        { type: "command", data: "secret-command" },
        { type: "usage", data: "secret-usage" },
        { type: "permission", data: "secret-permission" },
        { type: "protocol", data: "secret-protocol" },
        { type: "plan", entries: ["secret-plan"] },
        { type: "available_commands", commands: ["secret-cmd"] },
        { type: "tool_call_update", rawOutput: { stdout: "secret-output" } },
        { type: "text", data: "visible-answer" },
        { type: "end", sessionId: "sess-2" },
      ]),
    });
    expect(result.text).toBe("visible-answer");
    expect(result.text).not.toMatch(/secret/);
  });

  it("fails closed on malformed output", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: "{not-json\n{\"type\":\"text\",\"data\":\"x\"}\n",
    })).toThrow(/malformed/i);
  });

  it("fails closed on unknown events", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "mystery_delta", data: "should-not-leak" },
        { type: "text", data: "answer" },
        { type: "end", sessionId: "sess-3" },
      ]),
    })).toThrow(/unknown event/i);
  });

  it("fails closed without terminal session evidence", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([{ type: "text", data: "partial" }]),
    })).toThrow(/terminal session evidence/i);
  });

  it("fails closed when an error event arrives", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "partial" },
        { type: "error", message: "authentication required: please log in" },
      ]),
    })).toThrow(/authentication required/i);
  });

  it("does not treat a cancelled stream as a successful terminal result", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "thought", data: "still working" },
        { type: "text", data: "incomplete" },
      ]),
    })).toThrow(/terminal session evidence/i);
  });
});

describe("grok error classification", () => {
  it("classifies missing authentication without treating it as fallback capacity", () => {
    expect(classifyProviderError("grok", new Error("authentication required: grok login"))).toMatchObject({
      kind: "auth_required",
    });
    expect(classifyProviderError("grok", new Error("XAI_API_KEY is missing"))).toMatchObject({
      kind: "auth_required",
    });
  });
});

describe("grok session persistence", () => {
  it("stores and resumes a native grok session id", () => {
    const db = openDb(":memory:");
    expect(db.getSession("chat:1", "grok")).toBeNull();
    db.setSession("chat:1", "grok", "sess-live");
    expect(db.getSession("chat:1", "grok")).toBe("sess-live");
  });
});
