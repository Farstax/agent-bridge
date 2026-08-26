import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";
import { getProviderAdapter, PROVIDER_IDS, resolveProviderExecutable } from "../src/providers/registry.js";
import { interactiveChainKinds, parseCliChain } from "../src/providers/selection.js";
import { clearProviderApiKeyVerificationCache, verifyProviderApiKey } from "../src/providers/apiKeyAuth.js";
import { loadBotsConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import type { TelegramMessage } from "../src/types.js";

function grokStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("grok provider registration", () => {
  it("registers grok as an interactive fallback provider", () => {
    expect(PROVIDER_IDS).toContain("grok");
    const adapter = getProviderAdapter("grok");
    expect(adapter.displayName).toBe("Grok Build");
    expect(adapter.executable).toBe("grok");
    expect(adapter.capabilities.interactive).toBe(true);
    expect(adapter.capabilities.fallbackTarget).toBe(true);
    expect(adapter.capabilities.toolFree).toBe(false);
  });

  it("resolves a configurable grok executable instead of a generic agent binary", () => {
    expect(resolveProviderExecutable("grok", {})).toBe("grok");
    expect(resolveProviderExecutable("grok", { GROK_COMMAND: "/opt/xai/bin/grok" })).toBe("/opt/xai/bin/grok");
    expect(loadBotsConfig({}).grok.command).toBe("grok");
    expect(loadBotsConfig({ GROK_COMMAND: "/usr/local/bin/grok" }).grok.command).toBe("/usr/local/bin/grok");
  });

  it("supports the production default fallback with Grok ahead of Antigravity", () => {
    const fallback = ["codex", "claude", "grok", "antigravity"] as const;
    expect(parseCliChain(undefined, {
      allowed: interactiveChainKinds(),
      fallback,
    })).toEqual(["codex", "claude", "grok", "antigravity"]);
    expect(interactiveChainKinds()).toContain("grok");
  });

  it("still honors explicit INTERACTIVE_CLI_CHAIN overrides", () => {
    expect(parseCliChain("grok", {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "grok", "antigravity"],
    })).toEqual(["grok"]);
    expect(parseCliChain("codex,grok", {
      allowed: interactiveChainKinds(),
      fallback: ["codex", "claude", "grok", "antigravity"],
    })).toEqual(["codex", "grok"]);
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
        { type: "end", stopReason: "end_turn", sessionId: "sess-2" },
      ]),
    });
    expect(result.text).toBe("visible-answer");
    expect(result.text).not.toMatch(/secret/);
  });

  it("ignores documented auto_compact lifecycle events", () => {
    const result = parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "auto_compact_start" },
        { type: "text", data: "compacted-answer" },
        { type: "auto_compact_end" },
        { type: "end", stopReason: "end_turn", sessionId: "sess-compact" },
      ]),
    });
    expect(result.text).toBe("compacted-answer");
    expect(result.sessionId).toBe("sess-compact");
  });

  it("does not treat usage.stopReason as the terminal result", () => {
    const result = parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "after-tool" },
        { type: "usage", stopReason: "tool_use", input_tokens: 4 },
        { type: "end", stopReason: "end_turn", sessionId: "sess-usage" },
      ]),
    });
    expect(result.text).toBe("after-tool");
    expect(result.sessionId).toBe("sess-usage");
  });

  it.each(["end_turn", "success", "EndTurn", "Success"])(
    "accepts successful terminal stopReason %s",
    (stopReason) => {
      const result = parseCliResult({
        bot: "grok",
        stdout: grokStream([
          { type: "text", data: "done" },
          { type: "end", stopReason, sessionId: "sess-ok" },
        ]),
      });
      expect(result.text).toBe("done");
      expect(result.sessionId).toBe("sess-ok");
    },
  );

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
        { type: "end", stopReason: "end_turn", sessionId: "sess-3" },
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

  it("fails closed on documented max_turns_reached", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "partial" },
        { type: "max_turns_reached" },
      ]),
    })).toThrow(/max turns/i);
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

  it.each(["cancelled", "refusal", "max_tokens", "max_turn_requests"])(
    "fails closed when end.stopReason is %s even if text and sessionId are present",
    (stopReason) => {
      expect(() => parseCliResult({
        bot: "grok",
        stdout: grokStream([
          { type: "text", data: "partial answer" },
          { type: "end", stopReason, sessionId: "sess-partial" },
        ]),
      })).toThrow(/stop reason/i);
    },
  );

  it("fails closed when end.stopReason is missing", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "partial answer" },
        { type: "end", sessionId: "sess-missing-reason" },
      ]),
    })).toThrow(/stop reason/i);
  });

  it("fails closed when end.stopReason is unrecognized", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "partial answer" },
        { type: "end", stopReason: "mystery", sessionId: "sess-mystery" },
      ]),
    })).toThrow(/stop reason/i);
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

describe("grok engine dispatch", () => {
  it("invokes Grok streaming-json and persists the grok session, not Claude", async () => {
    const dbPath = join(tmpdir(), `grok-engine-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    const db = openDb(dbPath);
    const client = makeMockClient();
    const previousApiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-grok-key";
    // Routing requires a bounded native probe rather than trusting a non-empty
    // XAI_API_KEY; prime the verification cache for this fingerprint first.
    await verifyProviderApiKey("grok", { env: { XAI_API_KEY: "test-grok-key" }, execFile: async () => undefined });
    const runCli = vi.fn().mockImplementation(async (_command: string, _args: string[]) => grokStream([
      { type: "thought", data: "hide-me" },
      { type: "text", data: "Hello from Grok" },
      { type: "end", stopReason: "end_turn", sessionId: "grok-sess-1" },
    ]));

    try {
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["grok-4"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello grok")]);

      expect(runCli).toHaveBeenCalled();
      const [command, args] = runCli.mock.calls[0] as [string, string[]];
      expect(command).toBe("grok");
      expect(args).toContain("streaming-json");
      expect(args).not.toContain("stream-json");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(client.sendMessage.mock.calls.some((call: unknown[]) => {
        const body = call[0] as { text?: string };
        return body.text?.includes("Hello from Grok");
      })).toBe(true);
      expect(db.getSession("100", "grok")).toBe("grok-sess-1");
      expect(db.getSession("100", "claude")).toBeNull();

      runCli.mockClear();
      runCli.mockImplementation(async (_command: string, _args: string[]) => grokStream([
        { type: "text", data: "continued" },
        { type: "end", stopReason: "end_turn", sessionId: "grok-sess-1" },
      ]));
      await engine.handleMessages([makeMessage("continue")]);
      const resumeArgs = runCli.mock.calls[0][1] as string[];
      expect(resumeArgs).toContain("--resume");
      expect(resumeArgs).toContain("grok-sess-1");
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
      clearProviderApiKeyVerificationCache();
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});
