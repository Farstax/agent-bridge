import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";
import { type as eventType } from "../src/events/types.js";
import { markHandoffRequired, isHandoffRequired } from "../src/handoffState.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function makePrivateTopicMessage(text: string, threadId: number, userId = 42, chatId = 100): TelegramMessage {
  return {
    ...makeMessage(text, userId, chatId),
    message_thread_id: threadId,
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

function agyStreamJsonResult(responseText: string, sessionId = "11111111-1111-4111-8111-111111111111"): string {
  return JSON.stringify({ event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: responseText } });
}

function makeFullConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "claude", modelPreference: [] },
      antigravity: { token: undefined, command: "agy", modelPreference: [] },
      grok: { token: undefined, command: "grok", modelPreference: [] },
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("BridgeEngine", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    delete process.env.BRIDGE_ADVISOR_ENABLED;
    delete process.env.BRIDGE_ADVISOR_CHAIN;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("requires an explicit runtime surface identity", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    expect(() => new BridgeEngine({
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
    } as any, db, makeMockClient(), {})).toThrow("BridgeEngine surfaceIdentity is required");
  });

  describe("handoff consumption", () => {
    it("clears a pending handoff mark after the first turn for that chat+CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue(JSON.stringify({ type: "result", result: "Hello there!", session_id: "handoff-session" }));
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      markHandoffRequired(db, "100", "claude", "manual_switch");
      expect(isHandoffRequired(db, "100", "claude")).toBe(true);

      await engine.handleMessages([makeMessage("hello")]);

      expect(isHandoffRequired(db, "100", "claude")).toBe(false);
    });

    it("does not error when no handoff is pending", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue("Hello there!");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await expect(engine.handleMessages([makeMessage("hello")])).resolves.not.toThrow();
      expect(isHandoffRequired(db, "100", "claude")).toBe(false);
    });
  });

  describe("provider-native context handoff", () => {
    const MARKER = "earlier-turn-marker-XYZ123";

    it("does not inject context into a resumed native session", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      db.setSession("100", "claude", "existing-session-continuing");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("continue please")]);

      expect(capturedPrompt).not.toContain(MARKER);
    });

    it("does not inject context into a resumed native session by default", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      db.setSession("100", "claude", "existing-session-continuing");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("continue please")]);

      expect(capturedPrompt).not.toContain(MARKER);
    });

    it("handoff_once injects on the first turn when no native session exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(capturedPrompt).toContain(MARKER);
      expect(capturedPrompt).not.toContain("Active model:");
    });

    it("injects Soul and the active model once on handoff, then sends only the request on continuation", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompts.push(args[args.length - 1]);
        return JSON.stringify({ type: "result", result: "ok", session_id: "handoff-session" });
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        makeMockClient(),
        { runCli },
      );

      await engine.handleMessages([makeMessage("first handoff request")]);
      await engine.handleMessages([makeMessage("continuation request")]);

      expect(capturedPrompts[0]).toContain("Soul contract:");
      expect(capturedPrompts[0]).toContain("Active model: claude-primary");
      expect(capturedPrompts[0]).toContain(MARKER);
      expect(capturedPrompts[1]).not.toContain("Soul contract:");
      expect(capturedPrompts[1]).not.toContain("Active model:");
      expect(capturedPrompts[1]).not.toContain("Response contract:");
      expect(capturedPrompts[1]).not.toContain(MARKER);
      expect(capturedPrompts[1]).toContain("continuation request");
    });

    it("handoff_once suppresses context on a second same-provider turn once a native session exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      const capturedPrompts: string[] = [];
      const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompts.push(args[args.length - 1]);
        const rawOutput = JSON.stringify({ type: "result", result: "ok", session_id: "async-session-abc" });
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCliAsync },
      );

      await engine.handleMessages([makeMessage("first message")]);
      expect(capturedPrompts[0]).toContain(MARKER);
      expect(db.getSession("100", "claude")).toBe("async-session-abc");

      await engine.handleMessages([makeMessage("second message, same session")]);
      expect(capturedPrompts[1]).not.toContain(MARKER);
    });

    it("streams only Claude answer deltas into one preview while final output stays authoritative", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        options.onProviderOutputChunk?.(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "secret" } }] } })}\n`);
        options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "safe answer" } } })}\n`);
        options.onProviderOutputFinished?.();
        return { text: JSON.stringify({ type: "result", result: "safe answer", session_id: "stream-session" }) };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCliAsync },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("safe answer");
      expect(client.sendMessage.mock.calls[0][0].text).not.toContain("secret");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("safe answer") }));
      expect(db.getSession("100", "claude")).toBe("stream-session");
    });

    it("streams the same safe Claude preview through the runCli compatibility adapter", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sync answer" } } })}\n`);
        options.onProviderOutputFinished?.();
        return JSON.stringify({ result: "sync answer", session_id: "sync-stream-session" });
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("sync answer");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("sync answer") }));
    });

    it("streams only Antigravity agent responses into a visible preview", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        const streamOutput = [
          JSON.stringify({ event: "init", init: { cwd: "/tmp" } }),
          JSON.stringify({ event: "step_update", step_update: { step_type: "tool", text_delta: "secret tool output" } }),
          JSON.stringify({ event: "step_update", step_update: { step_type: "checkpoint", text_delta: "secret checkpoint" } }),
          JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "safe agent response" } }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "safe agent response", conversation_id: "11111111-1111-4111-8111-111111111111" } }),
        ].join("\n") + "\n";
        options.onProviderOutputChunk?.(streamOutput);
        options.onProviderOutputFinished?.();
        return { text: streamOutput };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "antigravity", botConfig: { command: "agy", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCliAsync },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("safe agent response");
      expect(client.sendMessage.mock.calls[0][0].text).not.toContain("secret tool output");
      expect(client.sendMessage.mock.calls[0][0].text).not.toContain("secret checkpoint");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("safe agent response"),
      }));
    });

    it("handoff_once injects when handoff_required is set even though a native session already exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      db.setSession("100", "claude", "stale-session-before-handoff-mark");
      markHandoffRequired(db, "100", "claude", "manual_switch");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello after switch")]);

      expect(capturedPrompt).not.toContain(MARKER);
      expect(isHandoffRequired(db, "100", "claude")).toBe(true);
    });

    it("handoff flag is only consumed on a turn where context was actually injected", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      db.setSession("100", "claude", "session-continuing");
      db.setSetting("ctx_suppress:100", "1");
      markHandoffRequired(db, "100", "claude", "manual_switch");

      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompts.push(args[args.length - 1]);
        return JSON.stringify({ type: "result", result: "ok", session_id: "fresh-after-suppression" });
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("suppressed turn")]);
      expect(capturedPrompts[0]).not.toContain(MARKER);
      expect(isHandoffRequired(db, "100", "claude")).toBe(true);

      db.setSetting("ctx_suppress:100", null);
      db.setSession("100", "claude", null);
      await engine.handleMessages([makeMessage("now it should inject")]);
      expect(capturedPrompts[1]).toContain(MARKER);
      expect(isHandoffRequired(db, "100", "claude")).toBe(false);
    });

    it("keeps Agent Bridge context env available under handoff_once even when the prompt preamble is suppressed", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      db.setSession("100", "claude", "session-continuing");

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[args.length - 1];
        capturedContextEnv = options.contextEnv;
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("continuing session")]);

      expect(capturedPrompt).not.toContain(MARKER);
      expect(capturedPrompt).not.toContain("[Agent Bridge context]");
      expect(capturedContextEnv).toMatchObject({
        AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
        AGENT_BRIDGE_CHAT_KEY: "100",
      });
      expect(capturedContextEnv?.AGENT_BRIDGE_CONTEXT_COMMAND).toContain("agent-bridge-context");
      expect(capturedContextEnv?.AGENT_BRIDGE_ADVISOR_COMMAND).toBeUndefined();
    });
  });

  describe("onCommand hook", () => {
    it("calls onCommand and uses its text result without invoking the CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue("should not be called");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "health",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: {
            onCommand: async (cmd) => cmd === "/health" ? { text: "All systems green." } : null,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/health")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("All systems green.");
    });

    it("falls through to built-in /start handler when onCommand returns null", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: {
            onCommand: async () => null,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("bridge ready");
    });

    it("handles /start with no hook configured (built-in path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("bridge ready");
    });
  });

  describe("onBeforeExecute hook", () => {
    it("calls onBeforeExecute and passes the transformed prompt to CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      let capturedPrompt: string | null = null;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "response";
      });

      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: {
            onBeforeExecute: async (prompt) => `CONTEXT: health ok\n\n${prompt}`,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("what is the disk usage?")]);

      expect(runCli).toHaveBeenCalledOnce();
      expect(capturedPrompt).toContain("CONTEXT: health ok");
      expect(capturedPrompt).toContain("what is the disk usage?");
    });

    it("does not call onBeforeExecute for commands (only for free-form prompts)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const beforeExecute = vi.fn().mockImplementation(async (p: string) => p);
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: { onBeforeExecute: beforeExecute },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(beforeExecute).not.toHaveBeenCalled();
      expect(runCli).not.toHaveBeenCalled();
    });

    it("uses executionKind for non-agent CLI invocation and parsing", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockResolvedValue(agyStreamJsonResult("Use the Agy-specific response."));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "health",
          executionKind: "antigravity",
          botConfig: { command: "agy", modelPreference: ["gemini-3-pro-preview"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: {
            onBeforeExecute: async (prompt) => `HEALTH CONTEXT\n\n${prompt}`,
          },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("diagnose health report")]);

      expect(runCli).toHaveBeenCalledOnce();
      const [command, args] = runCli.mock.calls[0];
      expect(command).toBe("agy");
      expect(args).toContain("--print");
      const outputFormatIdx = args.indexOf("--output-format");
      expect(outputFormatIdx).not.toBe(-1);
      expect(args[outputFormatIdx + 1]).toBe("stream-json");
      expect(client.sendMessage).toHaveBeenCalledOnce();
      expect(client.sendMessage.mock.calls[0][0].text).toBe("Use the Agy-specific response.");
    });

    it("retries Agy print timeouts once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer from Agy");
        if (runCli.mock.calls.length === 2) throw new Error("Agy execution timed out waiting for response");
        return agyStreamJsonResult("Recovered answer");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(db.getSession("100", "antigravity")).not.toBe("stale-conversation");
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("User request:");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered answer");
    });

    it("resets the Antigravity presentation decoder before a fresh retry", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const retrySessionId = "22222222-2222-4222-8222-222222222222";
      const retryOutput = [
        JSON.stringify({ event: "init", init: { cwd: "/tmp" } }),
        JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "recovered visible answer" } }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "recovered visible answer", conversation_id: retrySessionId } }),
      ].join("\n") + "\n";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        if (runCli.mock.calls.length === 1) {
          options.onProviderOutputChunk?.('{"event":"step_update","step_update":{"step_type":"agent_response"}');
          throw new Error("Agy execution timed out waiting for response");
        }
        options.onProviderOutputChunk?.(retryOutput);
        return retryOutput;
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "antigravity", botConfig: { command: "agy", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");
      await engine.handleMessages([makeMessage("retry after partial output")]);

      expect(runCli).toHaveBeenCalledTimes(2);
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("recovered visible answer"),
      }));
    });

    it("streams only agent responses through the canonical capacity fallback", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const fallbackSessionId = "33333333-3333-4333-8333-333333333333";
      const fallbackOutput = [
        JSON.stringify({ event: "init", init: { cwd: "/tmp" } }),
        JSON.stringify({ event: "step_update", step_update: { step_type: "tool", text_delta: "hidden tool output" } }),
        JSON.stringify({ event: "step_update", step_update: { step_type: "checkpoint", text_delta: "hidden checkpoint" } }),
        JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "visible fallback answer" } }),
        JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "visible fallback answer", conversation_id: fallbackSessionId } }),
      ].join("\n") + "\n";
      let attempts = 0;
      const providerRun = vi.fn((_cmd: string, _args: string[], _cwd: string, options: any) => {
        attempts += 1;
        if (attempts === 1) {
          options.onProviderOutputChunk?.('{"event":"step_update","step_update":{"step_type":"agent_response"}');
          throw new Error("MODEL_CAPACITY_EXHAUSTED");
        }
        options.onProviderOutputChunk?.(fallbackOutput);
        return { text: fallbackOutput };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "antigravity", botConfig: { command: "agy", modelPreference: ["primary", "fallback"] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
        db,
        client,
        { runCliAsync: providerRun as any },
      );

      await engine.handleMessages([makeMessage("capacity fallback")]);

      expect(providerRun).toHaveBeenCalledTimes(2);
      const deliveredTexts = [
        ...client.sendMessage.mock.calls.map((call: any[]) => String(call[0]?.text ?? "")),
        ...client.editMessageText.mock.calls.map((call: any[]) => String(call[0]?.text ?? "")),
      ];
      expect(deliveredTexts.some((text) => text.includes("visible fallback answer"))).toBe(true);
      expect(deliveredTexts.every((text) => !text.includes("hidden tool output") && !text.includes("hidden checkpoint"))).toBe(true);
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("visible fallback answer"),
      }));
    });

    it("retries recoverable Agy cascade errors once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer from Agy");
        if (runCli.mock.calls.length === 2) {
          throw new Error('{"type":"error","message":"error executing cascade step: CORTEX_STEP_TYPE_GREP_SEARCH: grep: -r: No such file or directory: exit status 2"}');
        }
        return agyStreamJsonResult("Recovered after reset");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered after reset");
    });

    it("retries stalled Agy planner loops once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer from Agy");
        if (runCli.mock.calls.length === 2) {
          throw new Error("Agy stalled in planner loop without usable output");
        }
        return agyStreamJsonResult("Recovered from stall");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("[Context from previous conversation]");
      expect(capturedPrompts[2]).toContain("User: first question");
      expect(capturedPrompts[2]).toContain("Assistant: Prior answer from Agy");
      expect(capturedPrompts[2]).toContain("second question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered from stall");
    });

    it("retries Agy cascade command status not found errors once with a fresh conversation", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer");
        if (runCli.mock.calls.length === 2) {
          throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command abc/task-22 not Found");
        }
        return agyStreamJsonResult("Recovered command status error");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      expect(capturedArgs[2]).not.toContain("--conversation");
      expect(capturedPrompts[2]).toContain("first question");
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered command status error");
    });

    it("retries a second fresh session when the first fresh retry also hits a recoverable cascade error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockImplementation(async () => {
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer");
        if (runCli.mock.calls.length <= 3) {
          throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command abc/task-18 not found");
        }
        return agyStreamJsonResult("Recovered on second fresh retry");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(4);
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered on second fresh retry");
    });

    it("commits a recoverable Agy fresh-session retry exactly once", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      let calls = 0;
      const execute = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return agyStreamJsonResult("Prior answer");
        if (calls === 2) throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command retry/task not found");
        return agyStreamJsonResult("Recovered exactly once.");
      });
      const onAfterExecute = vi.fn();
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
          hooks: { onAfterExecute },
        },
        db,
        client,
        { runCliAsync: async (...args: any[]) => ({ text: await execute(...args) }) },
      );

      db.setSession("100", "antigravity", "stale-conversation");
      await engine.handleMessages([makeMessage("first question")]);
      const turnsBeforeRetry = db.raw.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE chat_key = '100'").get() as { count: number };
      onAfterExecute.mockClear();

      await engine.handleMessages([makeMessage("second question")]);

      const turnsAfterRetry = db.raw.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE chat_key = '100'").get() as { count: number };
      expect(turnsAfterRetry.count - turnsBeforeRetry.count).toBe(2);
      expect(onAfterExecute).toHaveBeenCalledOnce();
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered exactly once.");
    });

    it("surfaces a friendly error instead of the raw cascade error when all fresh retries fail", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockImplementation(async () => {
        if (runCli.mock.calls.length === 1) return agyStreamJsonResult("Prior answer");
        throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command abc/task-18 not found");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runCli).toHaveBeenCalledTimes(4);
      const finalText = client.sendMessage.mock.calls.at(-1)?.[0].text as string;
      expect(finalText).not.toContain("CORTEX_STEP_TYPE");
      expect(finalText).toContain("internal cascade error");
      expect(finalText).toContain("resend");
    });
  });

  describe("authorization", () => {
    it("ignores messages from unauthorized user IDs", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn();
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["99999"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello", 42)]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("/stop handling", () => {
    it("sends abort confirmation and does not queue when /stop received", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleUpdate({ update_id: 1, message: makeMessage("/stop") });

      expect(client.sendMessage).toHaveBeenCalledOnce();
      const sentBody = client.sendMessage.mock.calls[0][0];
      expect(sentBody.text).toContain("aborted");
    });
  });

  describe("Telegram duplicate delivery", () => {
    it("executes a repeated message only once even when Telegram assigns another update id", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue("ok");
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );
      const message = makeMessage("one prompt");

      await engine.handleUpdate({ update_id: 1, message });
      await engine.handleUpdate({ update_id: 2, message: { ...message } });

      expect(runCli).toHaveBeenCalledOnce();
    });
  });

  describe("concurrency lock", () => {
    it("queues a second message silently when first is still holding the lock", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.acquireLock("test", "100");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeMessage("queued message")]);

      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(db.pendingMsgCount("test", "100")).toBe(1);
    });

    it("pending queue survives engine re-instantiation", () => {
      db.acquireLock("test", "chat:1");
      db.enqueueMsg("test", "chat:1", { prompt: "hello", chatId: 1, chatType: "private" });
      expect(db.pendingMsgCount("test", "chat:1")).toBe(1);
      const msgs = db.dequeueMsgs("test", "chat:1");
      expect(msgs[0].prompt).toBe("hello");
    });

    it("lets standalone bot surfaces execute concurrently for the same chat", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstRun = vi.fn().mockImplementation(async () => {
        markFirstStarted();
        await firstBlocked;
        return "codex done";
      });
      const secondRun = vi.fn().mockResolvedValue("claude done");
      const codex = new BridgeEngine({
        kind: "codex", surfaceIdentity: "telegram:codex",
        botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: firstRun });
      const claude = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:claude",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: secondRun });

      const codexTask = codex.handleMessages([makeMessage("codex")]);
      await firstStarted;
      await claude.handleMessages([makeMessage("claude")]);

      const ranConcurrently = secondRun.mock.calls.length === 1;
      db.raw.exec("DELETE FROM pending_messages");
      releaseFirst();
      await codexTask;
      expect(ranConcurrently).toBe(true);
    });

    it("lets different private topics execute concurrently on one interactive surface", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstRun = vi.fn().mockImplementation(async () => {
        markFirstStarted();
        await firstBlocked;
        return "topic 7 done";
      });
      const secondRun = vi.fn().mockResolvedValue("topic 8 done");
      const topic7 = new BridgeEngine({
        kind: "codex", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: firstRun });
      const topic8 = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: secondRun });

      const topic7Task = topic7.handleMessages([makePrivateTopicMessage("seven", 7)]);
      await firstStarted;
      await topic8.handleMessages([makePrivateTopicMessage("eight", 8)]);

      const ranConcurrently = secondRun.mock.calls.length === 1;
      db.raw.exec("DELETE FROM pending_messages");
      releaseFirst();
      await topic7Task;
      expect(ranConcurrently).toBe(true);
    });

    it("queues a second turn in the same private topic and interactive surface", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      let releaseFirst!: () => void;
      let markFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
      const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const firstRun = vi.fn().mockImplementation(async () => {
        markFirstStarted();
        await firstBlocked;
        return "first done";
      });
      const secondRun = vi.fn().mockResolvedValue("second done");
      const firstClient = makeMockClient();
      const secondClient = makeMockClient();
      const first = new BridgeEngine({
        kind: "codex", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1000,
      }, db, firstClient, { runCli: firstRun });
      const second = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1000,
      }, db, secondClient, { runCli: secondRun });

      const firstTask = first.handleMessages([makePrivateTopicMessage("first", 7)]);
      await firstStarted;
      await second.handleMessages([makePrivateTopicMessage("second", 7)]);

      expect(secondRun).not.toHaveBeenCalled();
      expect(secondClient.sendMessage.mock.calls.some((call: any[]) => call[0]?.text?.includes("Queued"))).toBe(false);
      expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
      db.raw.exec("DELETE FROM pending_messages");
      releaseFirst();
      await firstTask;
    });

    it("private-topic /stop clears only the queue owned by that topic lane", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const surface = "telegram:interactive";
      db.enqueueMsg(surface, "100:7", {
        prompt: "topic seven queued", chatId: 100, threadId: 7, chatType: "private",
      });
      db.enqueueMsg(surface, "100:8", {
        prompt: "topic eight queued", chatId: 100, threadId: 8, chatType: "private",
      });
      const engine = new BridgeEngine({
        kind: "codex", surfaceIdentity: surface,
        botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000,
      }, db, makeMockClient(), {});

      await engine.handleUpdate({ update_id: 1, message: makePrivateTopicMessage("/stop", 7) });

      expect(db.pendingMsgCount(surface, "100:7")).toBe(0);
      expect(db.pendingMsgCount(surface, "100:8")).toBe(1);
    });
  });

  describe("BridgeEvent persistence", () => {
    it("persists one run and lifecycle events from the async production path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = [
        JSON.stringify({ type: "thread.started", thread_id: "session-123" }),
        JSON.stringify({ type: "response.completed", output_text: "Persisted final answer" }),
      ].join("\n");

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        cwd: string,
        options: any,
      ) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "codex", cwd, model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeMessage("persist this run")]);

      const runs = db.raw.prepare("SELECT * FROM bridge_runs").all() as any[];
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        chat_id: "100",
        bot: "codex",
        status: "done",
        session_id: "session-123",
        final_text_preview: "Persisted final answer",
      });

      const events = db.getEventsForRun(runs[0].run_id);
      expect(events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
      expect(events.map((event) => JSON.parse(event.payload_json).type)).toEqual(["run.started", "run.completed"]);
    });
  });

  describe("onCapacityExhausted hook", () => {
    it("defers the queued capacity message until the final recovery attempt", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );
      const laneHandle = db.acquireLock("test", "100");
      expect(laneHandle).not.toBeNull();

      await engine.executeClaimedMessage({
        id: 1,
        chatKey: "100",
        prompt: "hello",
        chatId: 100,
        threadId: null,
        chatType: "private",
        userId: 42,
        attachments: [],
        laneHandle,
        laneLifecycleManaged: true,
        queueRecoveryAttempt: 2,
      } as any);

      expect(client.sendMessage).not.toHaveBeenCalled();

      await engine.executeClaimedMessage({
        id: 1,
        chatKey: "100",
        prompt: "hello",
        chatId: 100,
        threadId: null,
        chatType: "private",
        userId: 42,
        attachments: [],
        laneHandle,
        laneLifecycleManaged: true,
        queueRecoveryAttempt: 3,
      } as any);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("calls onCapacityExhausted when CLI throws a capacity error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
      const client = makeMockClient();
      const exhaustedChats: string[] = [];
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: { onCapacityExhausted: async (chatKey) => { exhaustedChats.push(chatKey); } },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      expect(exhaustedChats).toHaveLength(1);
      expect(exhaustedChats[0]).toBe("100");
    });

    it("does not call onCapacityExhausted for non-capacity errors", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockRejectedValue(new Error("some other error"));
      const client = makeMockClient();
      const exhaustedCalled = vi.fn();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: { onCapacityExhausted: exhaustedCalled },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      expect(exhaustedCalled).not.toHaveBeenCalled();
    });

    it("clears session ID, remembers recent turns, and retries with context on invalid session error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn()
        .mockResolvedValueOnce("Hello there! I am Claude.")
        .mockRejectedValueOnce(new Error("CLI exited with code 1: No conversation found with session ID: invalid-session-id-123"))
        .mockResolvedValueOnce("Successful fresh retry result");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      db.setSession("100", "claude", "invalid-session-id-123");
      await engine.handleMessages([makeMessage("help me")]);

      expect(db.getSession("100", "claude")).toBeNull();
      expect(runCli).toHaveBeenCalledTimes(3);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.sendMessage.mock.calls[1][0].text).toContain("Successful fresh retry result");

      const thirdCallArgs = runCli.mock.calls[2][1];
      const promptArg = thirdCallArgs[thirdCallArgs.length - 1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("User: hello");
      expect(promptArg).toContain("Assistant: Hello there! I am Claude.");
      expect(promptArg).toContain("help me");
      const contextBlocks = promptArg.match(/\[Context from previous conversation\]/g) ?? [];
      expect(contextBlocks).toHaveLength(1);
    });

    it("injects context on invalid-session retry under handoff_once, even though a valid-looking session existed beforehand", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn()
        .mockResolvedValueOnce("Hello there! I am Claude.")
        .mockRejectedValueOnce(new Error("CLI exited with code 1: No conversation found with session ID: invalid-session-id-123"))
        .mockResolvedValueOnce("Successful fresh retry result");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      db.setSession("100", "claude", "invalid-session-id-123");
      await engine.handleMessages([makeMessage("help me")]);

      expect(db.getSession("100", "claude")).toBeNull();
      const thirdCallArgs = runCli.mock.calls[2][1];
      const promptArg = thirdCallArgs[thirdCallArgs.length - 1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("help me");
      expect(promptArg.match(/Soul contract:/g) ?? []).toHaveLength(1);
      expect(promptArg.match(/Active model: claude-primary/g) ?? []).toHaveLength(1);
    });

    it("falls back to the next model in preference list and retries with context and null sessionId on capacity error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn()
        .mockResolvedValueOnce("Hello there! I am Claude Sonnet.")
        .mockRejectedValueOnce(new Error("CLI exited with code 1: You've hit your session limit · resets 1pm (Europe/London)"))
        .mockResolvedValueOnce(JSON.stringify({ result: "Successful fallback model retry result", session_id: "fallback-session" }))
        .mockResolvedValueOnce("Native continuation result");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-sonnet-4-6", "claude-opus-4-7"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      db.setSession("100", "claude", "session-sonnet-123");
      await engine.handleMessages([makeMessage("do something")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      const thirdCallArgs = runCli.mock.calls[2][1];
      const modelIdx = thirdCallArgs.indexOf("--model");
      expect(modelIdx).not.toBe(-1);
      expect(thirdCallArgs[modelIdx + 1]).toBe("claude-opus-4-7");
      expect(thirdCallArgs.indexOf("--resume")).toBe(-1);
      const promptArg = thirdCallArgs[thirdCallArgs.length - 1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("User: hello");
      expect(promptArg).toContain("Assistant: Hello there! I am Claude Sonnet.");
      expect(promptArg).toContain("do something");
      expect(promptArg.match(/Soul contract:/g) ?? []).toHaveLength(1);
      expect(promptArg.match(/Active model: claude-opus-4-7/g) ?? []).toHaveLength(1);

      await engine.handleMessages([makeMessage("continue after fallback")]);
      const continuationArgs = runCli.mock.calls[3][1];
      const continuationPrompt = continuationArgs[continuationArgs.length - 1];
      expect(continuationPrompt).not.toContain("Soul contract:");
      expect(continuationPrompt).not.toContain("Active model:");
      expect(continuationPrompt).not.toContain("[Context from previous conversation]");
      expect(continuationPrompt).toContain("continue after fallback");
    });
  });

  function makeGroupMessage(text: string, userId = 42, chatId = 100, threadId = 7): TelegramMessage {
    return {
      message_id: Math.floor(Math.random() * 10000),
      chat: { id: chatId, type: "supergroup" },
      from: { id: userId, first_name: "Test" },
      message_thread_id: threadId,
      text,
    };
  }

  describe("topic-routed generated files and callbacks", () => {
    it("uses the topic-aware chatKey for output dirs and uploads files back to the originating thread", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      let runOutputDir = "";
      const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const promptArg = args[args.length - 1];
        const match = String(promptArg).match(/save it to (\/tmp\/bridge-out\/\S+)/);
        expect(match?.[1]).toMatch(/^\/tmp\/bridge-out\/claude-100:7-[0-9a-f-]+$/);
        runOutputDir = match![1];
        await import("node:fs/promises").then(({ writeFile }) => writeFile(join(match![1], "chart.png"), "PNG"));
        return "done";
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeGroupMessage("make a chart")]);
      expect(client.sendPhoto).toHaveBeenCalledOnce();
      expect(client.sendPhoto.mock.calls[0][0]).toBe(100);
      expect(client.sendPhoto.mock.calls[0][1]).toBe(join(runOutputDir, "chart.png"));
      expect(client.sendPhoto.mock.calls[0][3]).toEqual({ message_thread_id: 7 });
    });

    it("sends callback confirmation messages to the callback's source thread", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: ["gpt-5.5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        {},
      );

      await engine.handleCallback({
        id: "cb-1",
        from: { id: 42, first_name: "Test" },
        message: { message_id: 123, chat: { id: 100, type: "supergroup" }, message_thread_id: 7 },
        data: "model:codex:gpt-5.5",
      });

      const confirmation = client.sendMessage.mock.calls.find((call: any[]) => call[0]?.text?.includes("Model set"));
      expect(confirmation?.[0]).toMatchObject({ chat_id: 100, message_thread_id: 7 });
    });
  });

  describe("/stop in a supergroup thread", () => {
    it("clears the pending queue for the thread-aware key so the next queued message gets position 1", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const threadKey = "100:7";
      db.acquireLock("test", threadKey);
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeGroupMessage("first message")]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(1);
      client.sendMessage.mockClear();
      await engine.handleUpdate({ update_id: 2, message: makeGroupMessage("/stop") });
      expect(db.pendingMsgCount("test", threadKey)).toBe(0);
      client.sendMessage.mockClear();
      await engine.handleMessages([makeGroupMessage("second message")]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(1);
      expect(client.sendMessage.mock.calls.some((c: any[]) => c[0]?.text?.includes("Queued"))).toBe(false);
    });

    it("sends the abort confirmation into the correct thread", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleUpdate({ update_id: 1, message: makeGroupMessage("/stop") });
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const body = client.sendMessage.mock.calls[0][0];
      expect(body.text).toContain("aborted");
      expect(body.message_thread_id).toBe(7);
    });
  });

  describe("thread vs non-thread parity", () => {
    it("replaces a stale Agy conversation only under the originating topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const staleId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const replacementId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const topicKey = "100:7";
      db.setSession(topicKey, "antigravity", staleId);
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        capturedArgs.push(args);
        return agyStreamJsonResult("native topic response", replacementId);
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makePrivateTopicMessage("resume topic", 7)]);
      expect(capturedArgs[0]).toContain(staleId);
      expect(db.getSession(topicKey, "antigravity")).toBe(replacementId);
      expect(db.getSession("100", "antigravity")).toBeNull();
      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 100,
        message_thread_id: 7,
        text: expect.stringContaining("native topic response"),
      }));
    });

    it("stores session under flat chatId for private chat messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = JSON.stringify({ type: "result", result: "done", session_id: "private-session-xyz" });
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeMessage("hello from private")]);
      const flatKey = "100";
      expect(db.getSession(flatKey, "claude")).toBe("private-session-xyz");
      expect(db.getSession("100:undefined:42", "claude")).toBeNull();
    });

    it("private chat /stop clears the queue for the flat chat key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const flatKey = "100";
      db.acquireLock("test", flatKey);
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeMessage("first message")]);
      expect(db.pendingMsgCount("test", flatKey)).toBe(1);
      client.sendMessage.mockClear();
      await engine.handleUpdate({ update_id: 2, message: makeMessage("/stop") });
      expect(db.pendingMsgCount("test", flatKey)).toBe(0);
      client.sendMessage.mockClear();
      await engine.handleMessages([makeMessage("second message")]);
      expect(db.pendingMsgCount("test", flatKey)).toBe(1);
      expect(client.sendMessage.mock.calls.some((c: any[]) => c[0]?.text?.includes("Queued"))).toBe(false);
    });

    it("two messages in the same thread queue behind each other", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const threadKey = "100:7";
      db.acquireLock("test", threadKey);
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeGroupMessage("msg one", 42, 100, 7)]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(1);
      await engine.handleMessages([makeGroupMessage("msg two", 42, 100, 7)]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(2);
      expect(client.sendMessage.mock.calls.some((c: any[]) => c[0]?.text?.includes("Queued"))).toBe(false);
    });

    it("a message in a different thread is not blocked by a lock held in thread 7", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const thread7Key = "100:7";
      db.acquireLock("test", thread7Key);
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: "hi", source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: "hi", sessionId: null }));
        return { text: "hi" };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeGroupMessage("msg in thread 8", 42, 100, 8)]);
      expect(runCliAsync).toHaveBeenCalledOnce();
      const queuedMsg = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("Queued"));
      expect(queuedMsg).toBeUndefined();
    });
  });

  describe("session stored under topic-aware key after execution", () => {
    it("stores session under chatId:threadId for supergroup topic messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = JSON.stringify({ type: "result", result: "done", session_id: "thread-session-abc" });
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeGroupMessage("hello from thread")]);
      const threadKey = "100:7";
      const flatKey = "100";
      expect(db.getSession(threadKey, "claude")).toBe("thread-session-abc");
      expect(db.getSession(flatKey, "claude")).toBeNull();
    });

    it("drains queued supergroup topic messages with the original topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = JSON.stringify({ type: "result", result: "done", session_id: "queued-topic-session" });
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      const topicKey = "100:7";
      const blockingHandle = db.acquireLock("test", topicKey)!;
      await engine.handleMessages([makeGroupMessage("queued topic message", 42, 100, 7)]);
      db.unlock(blockingHandle);
      await engine.recoverPendingQueues();

      expect(runCliAsync).toHaveBeenCalledOnce();
      expect(db.getSession(topicKey, "claude")).toBe("queued-topic-session");
      expect(db.getSession("100", "claude")).toBeNull();
    });

    it("calls onAfterExecute hook with correct parameters on successful prompt execution", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue("CLI execution output");
      const afterExecute = vi.fn();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          hooks: { onAfterExecute: afterExecute },
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("run testing command")]);
      expect(runCli).toHaveBeenCalledOnce();
      expect(afterExecute).toHaveBeenCalledOnce();
      expect(afterExecute.mock.calls[0][0]).toBe("run testing command");
      expect(afterExecute.mock.calls[0][1]).toBe("CLI execution output");
      expect(afterExecute.mock.calls[0][2]).toEqual({ chatId: 100, chatKey: "100", threadId: undefined });
    });
  });

  describe("Agent Bridge context helper affordance", () => {
    it("injects helper env and prompt affordance when retained turns exist", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "remember work item #16", "claude");

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[args.length - 1];
        capturedContextEnv = options.contextEnv;
        return "done";
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("what was the work item?")]);
      expect(capturedContextEnv).toMatchObject({
        AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
        AGENT_BRIDGE_CHAT_KEY: "100",
      });
      expect(capturedContextEnv?.AGENT_BRIDGE_CONTEXT_COMMAND).toContain("agent-bridge-context");
      expect(capturedPrompt).toContain("[Agent Bridge context]");
      expect(capturedPrompt).toContain("$AGENT_BRIDGE_CONTEXT_COMMAND");
      expect(capturedPrompt).toContain("--recent 20");
      expect(capturedPrompt).toContain("--search");
      expect(capturedPrompt).toContain("remember work item #16");
      expect(capturedPrompt).not.toContain("Current objective:");
    });

    it("does not inject helper env or affordance when no stored context exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[args.length - 1];
        capturedContextEnv = options.contextEnv;
        return "done";
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);
      expect(capturedContextEnv).toBeUndefined();
      expect(capturedPrompt).not.toContain("[Agent Bridge context]");
    });
  });

  describe("/reset command", () => {
    it("clears surface-visible retained history without deleting ambiguous retired summaries", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "important context");
      db.addConvSummary("100", 1, 1, "Current objective:\n- important work");
      db.addConvTurn("200", "user", "other conversation context");
      db.addConvSummary("200", 2, 2, "Current objective:\n- other work");
      db.setSession("100", "claude", "existing-session");
      db.setSession("200", "claude", "other-session");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        client,
      );

      await engine.handleMessages([makeMessage("/reset")]);
      expect(db.getConvStatus("100", "test").turnCount).toBe(0);
      expect(db.getConvStatus("100", "test").latestSummaryAt).toBeNull();
      expect(db.getLatestConvSummary("100")?.summary_md).toContain("important work");
      expect(db.getSession("100", "claude")).toBeNull();
      expect(db.getConvStatus("200", "test").turnCount).toBe(1);
      expect(db.getLatestConvSummary("200")?.summary_md).toContain("other work");
      expect(db.getSession("200", "claude")).toBe("other-session");
    });

    it("suppresses context injection on the prompt following a reset", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "prior context");
      db.addConvSummary("100", 1, 1, "Current objective:\n- prior work");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "done";
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/reset")]);
      await engine.handleMessages([makeMessage("hello after reset")]);
      expect(capturedPrompt).not.toContain("prior context");
      expect(capturedPrompt).not.toContain("Current objective:");
      expect(capturedPrompt).not.toContain("Soul contract:");
      expect(capturedPrompt).not.toContain("Active model:");
      expect(capturedPrompt).toContain("hello after reset");
    });
  });
});
