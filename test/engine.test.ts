import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";
import { type as eventType } from "../src/events/types.js";
import { markHandoffRequired, isHandoffRequired } from "../src/handoffState.js";
import { acpEngineExec } from "./support/acpEngineExec.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Grok is ACP-transport now -- its session state routes through
 * db.putAcpSessionBinding/getAcpSessionBinding, not the classic
 * db.setSession/getSession(chatKey, kind) native-CLI session pointer.
 */
function setGrokSession(database: ReturnType<typeof openDb>, chatKey: string, sessionId: string | null): void {
  if (sessionId === null) {
    database.clearAcpSessionBinding(chatKey, "grok");
    return;
  }
  database.putAcpSessionBinding({ conversationId: chatKey, providerId: "grok", acpSessionId: sessionId, runId: null });
}

function getGrokSession(database: ReturnType<typeof openDb>, chatKey: string): string | null {
  return database.getAcpSessionBinding(chatKey, "grok")?.acpSessionId ?? null;
}

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
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      passiveSurroundingContext: false,
      formatting: "telegram-html",
    },
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

function cursorResult(text: string, sessionId = "cursor-session"): string {
  return [
    JSON.stringify({ type: "text", data: text }),
    JSON.stringify({ type: "end", sessionId, stopReason: "end_turn" }),
  ].join("\n") + "\n";
}

function makeFullConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000, workingDir: process.cwd(),
    executionMode: "safe",
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "cursor", modelPreference: [] },
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
      kind: "grok",
      botConfig: { command: "grok", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000, workingDir: process.cwd(),
    } as any, db, makeMockClient(), {})).toThrow("BridgeEngine surfaceIdentity is required");
  });

  describe("handoff consumption", () => {
    it("clears a pending handoff mark after the first turn for that chat+CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue(cursorResult("Hello there!", "handoff-session"));
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      markHandoffRequired(db, "100", "grok", "manual_switch");
      expect(isHandoffRequired(db, "100", "grok")).toBe(true);

      await engine.handleMessages([makeMessage("hello")]);

      expect(isHandoffRequired(db, "100", "grok")).toBe(false);
    });

    it("does not error when no handoff is pending", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue("Hello there!");
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await expect(engine.handleMessages([makeMessage("hello")])).resolves.not.toThrow();
      expect(isHandoffRequired(db, "100", "grok")).toBe(false);
    });
  });

  describe("provider-native context handoff", () => {
    const MARKER = "earlier-turn-marker-XYZ123";

    it("does not inject context into a resumed native session", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      setGrokSession(db, "100", "existing-session-continuing");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("ok", "existing-session-continuing");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "grok", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("continue please")]);

      expect(capturedPrompt).not.toContain(MARKER);
    });

    it("does not inject context into a resumed native session by default", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      setGrokSession(db, "100", "existing-session-continuing");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("ok", "existing-session-continuing");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "grok", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("continue please")]);

      expect(capturedPrompt).not.toContain(MARKER);
    });

    it("handoff_once injects on the first turn when no native session exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("ok");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "grok", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, acpEngineExec(runCli),
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
        capturedPrompts.push(args[1]);
        return cursorResult("ok", "handoff-session");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        makeMockClient(),
        acpEngineExec(runCli),
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
        capturedPrompts.push(args[1]);
        const rawOutput = cursorResult("ok", "async-session-abc");
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "grok", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, acpEngineExec(runCliAsync),
      );

      await engine.handleMessages([makeMessage("first message")]);
      expect(capturedPrompts[0]).toContain(MARKER);
      expect(getGrokSession(db, "100")).toBe("async-session-abc");

      await engine.handleMessages([makeMessage("second message, same session")]);
      expect(capturedPrompts[1]).not.toContain(MARKER);
    });

    it("streams Agy ACP provisional answers through the generic answer-delta seam", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runProviderInvocation = vi.fn().mockImplementation(async (_bot: string, _invocation: unknown, _cwd: string, options: any) => {
        options.onAnswerDelta?.("safe agent response");
        return { text: "safe agent response", sessionId: "agy-acp-session" };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "antigravity", botConfig: { command: "agy_acp_server.par", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, { runProviderInvocation },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("safe agent response");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining("safe agent response"),
      }));
    });

    it("handoff_once injects when handoff_required is set even though a native session already exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      setGrokSession(db, "100", "stale-session-before-handoff-mark");
      markHandoffRequired(db, "100", "grok", "manual_switch");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("ok");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "grok", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db, client, acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello after switch")]);

      expect(capturedPrompt).not.toContain(MARKER);
      expect(isHandoffRequired(db, "100", "grok")).toBe(true);
    });

    it("keeps Agent Bridge context env available under handoff_once even when the prompt preamble is suppressed", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      setGrokSession(db, "100", "session-continuing");

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[1];
        capturedContextEnv = options.contextEnv;
        return cursorResult("ok");
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db, client, acpEngineExec(runCli),
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
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: {
            onCommand: async (cmd) => cmd === "/health" ? { text: "All systems green." } : null,
          },
        },
        db,
        client,
        acpEngineExec(runCli),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: {
            onCommand: async () => null,
          },
        },
        db,
        client,
        acpEngineExec(runCli),
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
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
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
        capturedPrompt = args[1];
        return cursorResult("response");
      });

      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: {
            onBeforeExecute: async (prompt) => `CONTEXT: health ok\n\n${prompt}`,
          },
        },
        db,
        client,
        acpEngineExec(runCli),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: { onBeforeExecute: beforeExecute },
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("/start")]);

      expect(beforeExecute).not.toHaveBeenCalled();
      expect(runCli).not.toHaveBeenCalled();
    });

    it("uses executionKind for non-agent CLI invocation and parsing", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runProviderInvocation = vi.fn().mockResolvedValue({
        text: "Use the Agy-specific response.",
        sessionId: "agy-acp-session",
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "health",
          executionKind: "antigravity",
          botConfig: { command: "agy_acp_server.par", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: {
            onBeforeExecute: async (prompt) => `HEALTH CONTEXT\n\n${prompt}`,
          },
        },
        db,
        client,
        { runProviderInvocation },
      );

      await engine.handleMessages([makeMessage("diagnose health report")]);

      expect(runProviderInvocation).toHaveBeenCalledOnce();
      expect(runProviderInvocation.mock.calls[0][1]).toEqual(expect.objectContaining({
        transport: "acp-stdio",
        args: ["--uid="],
      }));
      expect(runProviderInvocation.mock.calls[0][1].args).not.toContain("--print");
      expect(client.sendMessage).toHaveBeenCalledOnce();
      expect(client.sendMessage.mock.calls[0][0].text).toBe("Use the Agy-specific response.");
    });

    it("does not retry Agy timeouts as a native fresh session", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const { CliTimeoutError } = await import("../src/cli.js");

      const runProviderInvocation = vi.fn()
        .mockResolvedValueOnce({ text: "Prior answer from Agy", sessionId: "sess-1" })
        .mockRejectedValueOnce(new CliTimeoutError("CLI execution timed out after 1ms"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy_acp_server.par", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        { runProviderInvocation },
      );

      db.setSession("100", "antigravity", "stale-conversation");

      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runProviderInvocation).toHaveBeenCalledTimes(2);
      expect(runProviderInvocation.mock.calls.every((call) => !call[1].args.includes("--print"))).toBe(true);
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).not.toBe("Recovered answer");
    });

    it("rejects stale native Agy settings callbacks instead of writing ACP values", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy_acp_server.par", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        {},
      );

      await engine.handleCallback({
        id: "cb-stale-agy",
        from: { id: 42, first_name: "Test" },
        message: { message_id: 123, chat: { id: 100, type: "private" } },
        data: "model:antigravity:stale-native-value",
      });

      expect(client.answerCallbackQuery.mock.calls[0][0]).toMatchObject({
        text: "This settings button has expired. Open the settings again.",
      });
      expect(db.getSetting("antigravity")).toBeNull();
    });

    it("streams Agy ACP fallback answers through the generic answer-delta seam", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      let attempts = 0;
      const runProviderInvocation = vi.fn(async (_bot: string, _invocation: unknown, _cwd: string, options: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error("MODEL_CAPACITY_EXHAUSTED");
        options.onAnswerDelta?.("visible fallback answer");
        return { text: "visible fallback answer", sessionId: "agy-fallback-session" };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "antigravity", botConfig: { command: "agy_acp_server.par", modelPreference: ["primary", "fallback"] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd() },
        db,
        client,
        { runProviderInvocation },
      );

      await engine.handleMessages([makeMessage("capacity fallback")]);

      expect(runProviderInvocation).toHaveBeenCalledTimes(2);
      const deliveredTexts = [
        ...client.sendMessage.mock.calls.map((call: any[]) => String(call[0]?.text ?? "")),
        ...client.editMessageText.mock.calls.map((call: any[]) => String(call[0]?.text ?? "")),
      ];
      expect(deliveredTexts.some((text) => text.includes("visible fallback answer"))).toBe(true);
    });

    it("does not enter native Agy cascade fresh-session retry", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runProviderInvocation = vi.fn()
        .mockResolvedValueOnce({ text: "Prior answer from Agy", sessionId: "sess-1" })
        .mockRejectedValueOnce(new Error("error executing cascade step: CORTEX_STEP_TYPE_GREP_SEARCH"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy_acp_server.par", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        { runProviderInvocation },
      );

      db.setSession("100", "antigravity", "stale-conversation");
      await engine.handleMessages([makeMessage("first question")]);
      await engine.handleMessages([makeMessage("second question")]);

      expect(runProviderInvocation).toHaveBeenCalledTimes(2);
      const finalText = String(client.sendMessage.mock.calls.at(-1)?.[0].text ?? "");
      expect(finalText).not.toBe("Recovered after reset");
      expect(finalText).not.toContain("internal cascade error");
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["99999"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
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
        kind: "grok", surfaceIdentity: "telegram:codex",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, makeMockClient(), acpEngineExec(firstRun));
      const claude = new BridgeEngine({
        kind: "grok", surfaceIdentity: "telegram:claude",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, makeMockClient(), acpEngineExec(secondRun));

      const codexTask = codex.handleMessages([makeMessage("codex")]);
      await firstStarted;
      await claude.handleMessages([makeMessage("cursor")]);

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
        kind: "grok", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, makeMockClient(), acpEngineExec(firstRun));
      const topic8 = new BridgeEngine({
        kind: "grok", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, makeMockClient(), acpEngineExec(secondRun));

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
        kind: "grok", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, firstClient, acpEngineExec(firstRun));
      const second = new BridgeEngine({
        kind: "grok", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, secondClient, acpEngineExec(secondRun));

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
        executionMode: "safe", pollIntervalMs: 1000, workingDir: process.cwd(),
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
      const rawOutput = cursorResult("Persisted final answer", "session-123");

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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCliAsync),
      );

      await engine.handleMessages([makeMessage("persist this run")]);

      const runs = db.raw.prepare("SELECT * FROM bridge_runs").all() as any[];
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        chat_id: "100",
        bot: "grok",
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: { onCapacityExhausted: async (chatKey) => { exhaustedChats.push(chatKey); } },
        },
        db,
        client,
        acpEngineExec(runCli),
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
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: { onCapacityExhausted: exhaustedCalled },
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello")]);
      expect(exhaustedCalled).not.toHaveBeenCalled();
    });

    it("clears session ID, remembers recent turns, and retries with context on invalid session error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn()
        .mockResolvedValueOnce(cursorResult("Hello there! I am Claude.", "cursor-first"))
        .mockRejectedValueOnce(new Error("CLI exited with code 1: No conversation found with session ID: invalid-session-id-123"))
        .mockResolvedValueOnce(cursorResult("Successful fresh retry result", "cursor-retry"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello")]);
      setGrokSession(db, "100", "invalid-session-id-123");
      await engine.handleMessages([makeMessage("help me")]);

      expect(getGrokSession(db, "100")).toBe("cursor-retry");
      expect(runCli).toHaveBeenCalledTimes(3);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(client.sendMessage.mock.calls[1][0].text).toContain("Successful fresh retry result");

      const thirdCallArgs = runCli.mock.calls[2][1];
      const promptArg = thirdCallArgs[1];
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
        .mockResolvedValueOnce(cursorResult("Hello there! I am Claude.", "cursor-first"))
        .mockRejectedValueOnce(new Error("CLI exited with code 1: No conversation found with session ID: invalid-session-id-123"))
        .mockResolvedValueOnce(cursorResult("Successful fresh retry result", "cursor-retry"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello")]);
      setGrokSession(db, "100", "invalid-session-id-123");
      await engine.handleMessages([makeMessage("help me")]);

      expect(getGrokSession(db, "100")).toBe("cursor-retry");
      const thirdCallArgs = runCli.mock.calls[2][1];
      const promptArg = thirdCallArgs[1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("help me");
      expect(promptArg.match(/Soul contract:/g) ?? []).toHaveLength(1);
      expect(promptArg.match(/Active model: claude-primary/g) ?? []).toHaveLength(1);
    });

    it("falls back to the next model in preference list and retries with context and null sessionId on capacity error", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn()
        .mockResolvedValueOnce(cursorResult("Hello there! I am Claude Sonnet.", "cursor-first"))
        .mockRejectedValueOnce(new Error("CLI exited with code 1: You've hit your session limit · resets 1pm (Europe/London)"))
        .mockResolvedValueOnce(cursorResult("Successful fallback model retry result", "fallback-session"))
        .mockResolvedValueOnce(cursorResult("Native continuation result", "fallback-session"));
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-sonnet-4-6", "claude-opus-4-7"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello")]);
      setGrokSession(db, "100", "session-sonnet-123");
      await engine.handleMessages([makeMessage("do something")]);

      expect(runCli).toHaveBeenCalledTimes(3);
      const thirdCallArgs = runCli.mock.calls[2][1];
      const modelIdx = thirdCallArgs.indexOf("--model");
      expect(modelIdx).not.toBe(-1);
      expect(thirdCallArgs[modelIdx + 1]).toBe("claude-opus-4-7");
      expect(thirdCallArgs.indexOf("--resume")).toBe(-1);
      const promptArg = thirdCallArgs[1];
      expect(promptArg).toContain("[Context from previous conversation]");
      expect(promptArg).toContain("User: hello");
      expect(promptArg).toContain("Assistant: Hello there! I am Claude Sonnet.");
      expect(promptArg).toContain("do something");
      expect(promptArg.match(/Soul contract:/g) ?? []).toHaveLength(1);
      expect(promptArg.match(/Active model: claude-opus-4-7/g) ?? []).toHaveLength(1);

      await engine.handleMessages([makeMessage("continue after fallback")]);
      const continuationArgs = runCli.mock.calls[3][1];
      const continuationPrompt = continuationArgs[1];
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
        const promptArg = args[1];
        const match = String(promptArg).match(/save it to (\/tmp\/bridge-out\/\S+)/);
        expect(match?.[1]).toMatch(/^\/tmp\/bridge-out\/cursor-100:7-[0-9a-f-]+$/);
        runOutputDir = match![1];
        await import("node:fs/promises").then(({ writeFile }) => writeFile(join(match![1], "chart.png"), "PNG"));
        return cursorResult("done");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "cursor",
          botConfig: { command: "cursor", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeGroupMessage("make a chart")]);
      expect(client.sendPhoto).toHaveBeenCalledOnce();
      expect(client.sendPhoto.mock.calls[0][0]).toBe(100);
      expect(client.sendPhoto.mock.calls[0][1]).toBe(join(runOutputDir, "chart.png"));
      expect(client.sendPhoto.mock.calls[0][3]).toEqual({ message_thread_id: "7" });
    });

    it("sends callback confirmation messages to the callback's source thread", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const { replaceAcpSessionConfigSnapshot, clearAcpSessionConfigSnapshot } = await import("../src/acp/sessionConfig.js");
      const { buildAcpTelegramConfigCallbackData } = await import("../src/acp/telegramConfigCallback.js");
      replaceAcpSessionConfigSnapshot("codex", [{
        id: "model",
        category: "model",
        type: "select",
        currentValue: "gpt-5.5",
        options: [{ value: "gpt-5.5", name: "GPT-5.5" }],
      }]);
      try {
        const client = makeMockClient();
        const engine = new BridgeEngine(
          {
            surfaceIdentity: "test",
            kind: "codex",
            botConfig: { command: "codex", modelPreference: ["gpt-5.5"] },
            allowedUserIds: new Set(["42"]),
            executionMode: "safe",
            pollIntervalMs: 1000, workingDir: process.cwd(),
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
          data: buildAcpTelegramConfigCallbackData("codex", "model", "gpt-5.5"),
        });

        const confirmation = client.sendMessage.mock.calls.find((call: any[]) => call[0]?.text?.includes("Model set"));
        expect(confirmation?.[0]).toMatchObject({ chat_id: 100, message_thread_id: 7 });
      } finally {
        clearAcpSessionConfigSnapshot("codex");
      }
    });

    it("rejects stale native Grok settings callbacks instead of writing ACP values", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        {},
      );

      await engine.handleCallback({
        id: "cb-stale-grok",
        from: { id: 42, first_name: "Test" },
        message: { message_id: 123, chat: { id: 100, type: "private" } },
        data: "model:grok:stale-native-value",
      });

      expect(client.answerCallbackQuery.mock.calls[0][0]).toMatchObject({
        text: "This settings button has expired. Open the settings again.",
      });
      expect(db.getSetting("grok")).toBeNull();
    });

    it("rejects stale native Cursor settings callbacks instead of writing ACP values", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "cursor",
          botConfig: { command: "cursor-agent", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        {},
      );

      await engine.handleCallback({
        id: "cb-stale-cursor",
        from: { id: 42, first_name: "Test" },
        message: { message_id: 123, chat: { id: 100, type: "private" } },
        data: "model:cursor:stale-native-value",
      });

      expect(client.answerCallbackQuery.mock.calls[0][0]).toMatchObject({
        text: "This settings button has expired. Open the settings again.",
      });
      expect(db.getSetting("cursor")).toBeNull();
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        {},
      );

      await engine.handleUpdate({ update_id: 1, message: makeGroupMessage("/stop") });
      expect(client.sendMessage).toHaveBeenCalledOnce();
      const body = client.sendMessage.mock.calls[0][0];
      expect(body.text).toContain("aborted");
      expect(body.message_thread_id).toBe("7");
    });
  });

  describe("thread vs non-thread parity", () => {
    it("replaces a stale Agy conversation only under the originating topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const staleId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const replacementId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const topicKey = "100:7";
      db.putAcpSessionBinding({
        conversationId: topicKey,
        providerId: "agy",
        acpSessionId: staleId,
        runId: null,
      });
      const runProviderInvocation = vi.fn().mockResolvedValue({
        text: "native topic response",
        sessionId: replacementId,
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy_acp_server.par", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        { runProviderInvocation },
      );

      await engine.handleMessages([makePrivateTopicMessage("resume topic", 7)]);
      expect(runProviderInvocation.mock.calls[0][4].sessionId).toBe(staleId);
      expect(db.getAcpSessionBinding(topicKey, "agy")?.acpSessionId).toBe(replacementId);
      expect(db.getAcpSessionBinding("100", "agy")).toBeNull();
      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        chat_id: 100,
        message_thread_id: "7",
        text: expect.stringContaining("native topic response"),
      }));
    });

    it("stores session under flat chatId for private chat messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = cursorResult("done", "private-session-xyz");
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "grok", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCliAsync),
      );

      await engine.handleMessages([makeMessage("hello from private")]);
      const flatKey = "100";
      expect(getGrokSession(db, flatKey)).toBe("private-session-xyz");
      expect(getGrokSession(db, "100:undefined:42")).toBeNull();
    });

    it("private chat /stop clears the queue for the flat chat key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const flatKey = "100";
      db.acquireLock("test", flatKey);
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
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
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1000, workingDir: process.cwd(),
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
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "grok", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: "hi", source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: "hi", sessionId: null }));
        return { text: "hi" };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCliAsync),
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
      const rawOutput = cursorResult("done", "thread-session-abc");
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "grok", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCliAsync),
      );

      await engine.handleMessages([makeGroupMessage("hello from thread")]);
      const threadKey = "100:7";
      const flatKey = "100";
      expect(getGrokSession(db, threadKey)).toBe("thread-session-abc");
      expect(getGrokSession(db, flatKey)).toBeNull();
    });

    it("drains queued supergroup topic messages with the original topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = cursorResult("done", "queued-topic-session");
      const runCliAsync = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "grok", cwd: "/", model: null }));
        options.onEvent?.(eventType.textDelta({ ...ctx, text: rawOutput, source: "stdout" }));
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCliAsync),
      );

      const topicKey = "100:7";
      const blockingHandle = db.acquireLock("test", topicKey)!;
      await engine.handleMessages([makeGroupMessage("queued topic message", 42, 100, 7)]);
      db.unlock(blockingHandle);
      await engine.recoverPendingQueues();

      expect(runCliAsync).toHaveBeenCalledOnce();
      expect(getGrokSession(db, topicKey)).toBe("queued-topic-session");
      expect(getGrokSession(db, "100")).toBeNull();
    });

    it("calls onAfterExecute hook with correct parameters on successful prompt execution", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue(cursorResult("CLI execution output"));
      const afterExecute = vi.fn();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          hooks: { onAfterExecute: afterExecute },
        },
        db,
        client,
        acpEngineExec(runCli),
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
      db.addConvTurn("100", "user", "remember work item #16", "grok");

      let capturedPrompt = "";
      let capturedContextEnv: Record<string, string> | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompt = args[1];
        capturedContextEnv = options.contextEnv;
        return cursorResult("done");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        acpEngineExec(runCli),
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
        capturedPrompt = args[1];
        capturedContextEnv = options.contextEnv;
        return cursorResult("done");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        acpEngineExec(runCli),
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
      setGrokSession(db, "100", "existing-session");
      setGrokSession(db, "200", "other-session");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
      );

      await engine.handleMessages([makeMessage("/reset")]);
      expect(db.getConvStatus("100", "test").turnCount).toBe(0);
      expect(db.getConvStatus("100", "test").latestSummaryAt).toBeNull();
      expect(db.getLatestConvSummary("100")?.summary_md).toContain("important work");
      expect(getGrokSession(db, "100")).toBeNull();
      expect(db.getConvStatus("200", "test").turnCount).toBe(1);
      expect(db.getLatestConvSummary("200")?.summary_md).toContain("other work");
      expect(getGrokSession(db, "200")).toBe("other-session");
    });

    it("re-seeds baseline fresh-session context after reset without restoring deleted history", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "prior context");
      db.addConvSummary("100", 1, 1, "Current objective:\n- prior work");

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[1];
        return cursorResult("done");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
          soulContext: "Identity: Weaver",
          workspaceContext: "Role: Farstax control-plane agent",
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("/reset")]);
      await engine.handleMessages([makeMessage("hello after reset")]);
      expect(capturedPrompt).not.toContain("prior context");
      expect(capturedPrompt).not.toContain("Current objective:");
      expect(capturedPrompt).toContain("[Managed workspace context]");
      expect(capturedPrompt).toContain("Role: Farstax control-plane agent");
      expect(capturedPrompt).toContain("Soul contract:");
      expect(capturedPrompt).toContain("Active model: claude-primary");
      expect(capturedPrompt).toContain("Response contract:");
      expect(capturedPrompt).toContain("hello after reset");
    });
  });

  describe("group/topic chat run persistence", () => {
    function makeSupergroupTopicMessage(text: string, chatId: number, threadId: number, userId = 42): TelegramMessage {
      return {
        message_id: Math.floor(Math.random() * 10000),
        chat: { id: chatId, type: "supergroup" },
        from: { id: userId, first_name: "Test" },
        text,
        message_thread_id: threadId,
      };
    }

    it("persists bridge_runs, bridge_events, and conversation_turns for a supergroup forum-topic run", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const chatId = -1004366290625;
      const threadId = 1458;
      const chatKey = `${chatId}:${threadId}`;
      // Faithfully mirror cliSupervisor.runSupervisedProcess(), which emits
      // run.started via options.onEvent before the process resolves.
      const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        if (options?.eventContext) {
          options.onEvent?.(eventType.runStarted({ ...options.eventContext, command: "grok", cwd: "/", model: null }));
        }
        return cursorResult("topic answer", "topic-session");
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeSupergroupTopicMessage("hello from the topic", chatId, threadId)]);

      const runs = db.raw.prepare("SELECT run_id, chat_id, bot, status, final_text_preview FROM bridge_runs WHERE chat_id = ?").all(chatKey) as Array<{ run_id: string; chat_id: string; bot: string; status: string; final_text_preview: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("done");
      expect(runs[0].final_text_preview).toBe("topic answer");

      const events = db.raw.prepare("SELECT type FROM bridge_events WHERE run_id = ? ORDER BY seq ASC").all(runs[0].run_id) as Array<{ type: string }>;
      expect(events.map((e) => e.type)).toEqual(["run.started", "run.completed"]);

      const turns = db.raw.prepare("SELECT role, text FROM conversation_turns WHERE chat_key = ? ORDER BY id ASC").all(chatKey) as Array<{ role: string; text: string }>;
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({ role: "user", text: "hello from the topic" });
      expect(turns[1]).toMatchObject({ role: "assistant", text: "topic answer" });

      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("topic answer");
    });

    it("does not regress private DM persistence alongside a topic run", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue(cursorResult("dm answer", "dm-session"));
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      await engine.handleMessages([makeMessage("hello from DM")]);

      const runs = db.raw.prepare("SELECT run_id, status, final_text_preview FROM bridge_runs WHERE chat_id = ?").all("100") as Array<{ run_id: string; status: string; final_text_preview: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("done");
      expect(runs[0].final_text_preview).toBe("dm answer");

      const turns = db.raw.prepare("SELECT role, text FROM conversation_turns WHERE chat_key = ? ORDER BY id ASC").all("100") as Array<{ role: string; text: string }>;
      expect(turns).toHaveLength(2);
    });
  });

  describe("conversation-turn write failure handling", () => {
    it("does not deliver a second error message when persisting the turn fails after the real answer was already sent", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue(cursorResult("the real answer", "real-session"));
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "grok",
          botConfig: { command: "grok", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        },
        db,
        client,
        acpEngineExec(runCli),
      );

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const addConvTurnSpy = vi.spyOn(db, "addConvTurn").mockImplementationOnce(() => {
        throw new Error("simulated conversation_turns write failure");
      });

      await engine.handleMessages([makeMessage("hello")]);

      // Exactly one delivery: the real answer. No follow-up "❌ ..." message
      // caused by the turn-write failure leaking out as an execution error.
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toBe("the real answer");

      const turnFailureWarnings = warn.mock.calls.filter(([msg]) => String(msg).includes("conversation-turn write"));
      expect(turnFailureWarnings).toHaveLength(1);
      const [message] = turnFailureWarnings[0];
      expect(message).toContain("100");
      expect(message).not.toContain("hello");
      expect(message).not.toContain("the real answer");

      addConvTurnSpy.mockRestore();
      warn.mockRestore();
    });
  });
});
