import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";
import { type as eventType } from "../src/events/types.js";
import { markHandoffRequired, isHandoffRequired } from "../src/handoffState.js";
import { compactInProgressSettingKey } from "../src/commands.js";

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

/** Wraps a compact markdown summary in the structured JSON output the compact prompt now requires. */
function compactJson(summaryMd: string, memoryCandidates: unknown[] = []): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: memoryCandidates });
}

function codexCompactEvents(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "compact-thread" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  ].join("\n");
}

function makeFullConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "claude", modelPreference: [] },
      antigravity: { token: undefined, command: "agy", modelPreference: [] },
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
    delete process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS;
    delete process.env.BRIDGE_COMPACT_PARALLELISM;
    delete process.env.BRIDGE_MEMORY_EXTRACTOR_ENABLED;
    delete process.env.BRIDGE_PRESEED_COMPACT_MODE;
    delete process.env.BRIDGE_PRESEED_COMPACT_CHARS;
    delete process.env.BRIDGE_COMPACTION_CHAIN;
    delete process.env.BRIDGE_ADVISOR_ENABLED;
    delete process.env.BRIDGE_ADVISOR_CHAIN;
    delete process.env.ANTIGRAVITY_OUTPUT_MODE;
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
      asyncEnabled: false,
      pollIntervalMs: 1000,
    } as any, db, makeMockClient(), {})).toThrow("BridgeEngine surfaceIdentity is required");
  });

  describe("handoff consumption", () => {
    it("clears a pending handoff mark after the first turn for that chat+CLI", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockResolvedValue(JSON.stringify({ result: "Hello there!", session_id: "handoff-session" }));
      const client = makeMockClient();

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
          asyncEnabled: false,
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
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
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
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("continue please")]);

      expect(capturedPrompt).not.toContain(MARKER);
    });

    it("handoff_once injects on the first turn when no native session exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);
      // No db.setSession call — sessionId is null for this chat+CLI.

      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
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
        return JSON.stringify({ result: "ok", session_id: "handoff-session" });
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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

    it("handoff_once suppresses context on a second same-provider turn once a native session exists (sync path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompts.push(args[args.length - 1]);
        return JSON.stringify({ result: "ok", session_id: "sync-session-abc" });
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("first message")]);
      expect(capturedPrompts[0]).toContain(MARKER);
      expect(db.getSession("100", "claude")).toBe("sync-session-abc");

      await engine.handleMessages([makeMessage("second message, same session")]);
      expect(capturedPrompts[1]).not.toContain(MARKER);
      expect(capturedPrompts[1]).not.toContain("[Context from previous conversation]");
    });

    it("handoff_once suppresses context on a second same-provider turn once a native session exists (async path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addConvTurn("100", "user", MARKER);

      const capturedPrompts: string[] = [];
      const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        capturedPrompts.push(args[args.length - 1]);
        const rawOutput = JSON.stringify({ result: "ok", session_id: "async-session-abc" });
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000 },
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
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000 },
        db, client, { runCliAsync },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("safe answer");
      expect(client.sendMessage.mock.calls[0][0].text).not.toContain("secret");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("safe answer") }));
      expect(db.getSession("100", "claude")).toBe("stream-session");
    });

    it("streams the same safe Claude preview on the synchronous Telegram path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
        options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sync answer" } } })}\n`);
        options.onProviderOutputFinished?.();
        return JSON.stringify({ result: "sync answer", session_id: "sync-stream-session" });
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("sync answer");
      expect(client.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("sync answer") }));
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
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
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
      db.setSetting("ctx_suppress:100", "1"); // forces suppression regardless of handoff mark
      markHandoffRequired(db, "100", "claude", "manual_switch");

      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompts.push(args[args.length - 1]);
        return JSON.stringify({ result: "ok", session_id: "fresh-after-suppression" });
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("suppressed turn")]);
      expect(capturedPrompts[0]).not.toContain(MARKER);
      // Suppressed by ctx_suppress even though handoff was marked — flag must survive uncomsumed.
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("continuing session")]);

      // Prompt preamble (both the recent-turn context and the "[Agent Bridge context]"
      // usage-instructions block) must be suppressed...
      expect(capturedPrompt).not.toContain(MARKER);
      expect(capturedPrompt).not.toContain("[Agent Bridge context]");
      // ...but the env vars must remain available so the CLI can self-serve query it.
      expect(capturedContextEnv).toMatchObject({
        AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
        AGENT_BRIDGE_CHAT_KEY: "100",
      });
      expect(capturedContextEnv?.AGENT_BRIDGE_CONTEXT_COMMAND).toContain("agent-bridge-context");
      expect(capturedContextEnv?.AGENT_BRIDGE_ADVISOR_COMMAND).toBeUndefined();
    });
  });

  describe("pre-seed compaction (BRIDGE_PRESEED_COMPACT_MODE)", () => {
    function seedLongTurns(chatKey: string, count = 5) {
      for (let i = 0; i < count; i++) {
        db.addConvTurn(chatKey, "user", `turn-${i}-${"x".repeat(50)}`);
      }
    }

    it("does not compact when mode is off (default) even past the char threshold", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");

      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) throw new Error("compaction must not run when mode is off");
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(db.getLatestConvSummary("100")).toBeNull();
    });

    it("compacts before injecting context when mode=auto and the char threshold is exceeded on a fresh-seed turn", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");

      let mainPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) {
          return compactJson("Current objective:\n- preseeded\n\nDurable facts:\n- none\n\nOpen state:\n- none");
        }
        mainPrompt = prompt;
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(db.getLatestConvSummary("100")).not.toBeNull();
      expect(mainPrompt).toContain("preseeded");
    });

    it("uses the configured recovery chain through the real pre-seed engine path", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      process.env.BRIDGE_COMPACTION_CHAIN = "codex:gpt-preseed-fallback";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");

      const commands: string[] = [];
      const runCli = vi.fn().mockImplementation(async (command: string, args: string[]) => {
        const prompt = args[args.length - 1];
        commands.push(command);
        if (prompt.includes("Summarise now:")) {
          if (command === "claude") throw new Error("Authentication required: please log in");
          return codexCompactEvents(compactJson("Current objective:\n- preseed fallback\n\nDurable facts:\n- none\n\nOpen state:\n- none"));
        }
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(commands.slice(0, 2)).toEqual(["claude", "codex"]);
      expect(db.getLatestConvSummary("100")?.summary_md).toContain("preseed fallback");
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?")
        .get("100")).toEqual({ count: 1 });
      expect(db.getLatestCompactionAttempt("100")).toEqual(expect.objectContaining({
        trigger: "preseed",
        provider: "codex",
        model: "gpt-preseed-fallback",
        outcome: "compacted",
        cli_call_count: 2,
      }));
    });

    it("does not compact when there are zero uncompacted turns", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      // No addConvTurn calls — chat has no history at all.

      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) throw new Error("compaction must not run with zero turns");
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await expect(engine.handleMessages([makeMessage("hello")])).resolves.not.toThrow();
      expect(db.getLatestConvSummary("100")).toBeNull();
    });

    it("respects the compact-in-progress guard and skips pre-seed compaction", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");
      db.setSetting(compactInProgressSettingKey("100"), new Date().toISOString());

      let mainPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) throw new Error("compaction must not run while already in progress");
        mainPrompt = prompt;
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(db.getLatestConvSummary("100")).toBeNull();
      expect(mainPrompt).toContain("hello");
      expect(runCli).toHaveBeenCalledTimes(1);
    });

    it("does not block execution when pre-seed compaction fails", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");

      let mainPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) throw new Error("simulated compaction LLM failure");
        mainPrompt = prompt;
        return "ok";
      });
      const client = makeMockClient();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000 },
        db, client, { runCli },
      );

      await expect(engine.handleMessages([makeMessage("hello")])).resolves.not.toThrow();
      expect(db.getLatestConvSummary("100")).toBeNull();
      expect(mainPrompt).toContain("hello");
      expect(db.getSetting(compactInProgressSettingKey("100"))).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[preseed-compact] failed outcome"));
    });

    it("runs on the async execution path as well", async () => {
      process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
      process.env.BRIDGE_PRESEED_COMPACT_CHARS = "10";
      const { BridgeEngine } = await import("../src/engine.js");
      seedLongTurns("100");

      const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
        const prompt = args[args.length - 1];
        const rawOutput = JSON.stringify({ result: "ok", session_id: "async-session-preseed" });
        const ctx = options.eventContext;
        options.onEvent?.(eventType.runCompleted({ ...ctx, text: rawOutput, sessionId: null }));
        return { text: rawOutput };
      });
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Summarise now:")) {
          return compactJson("Current objective:\n- preseeded-async\n\nDurable facts:\n- none\n\nOpen state:\n- none");
        }
        return "ok";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        { surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000 },
        db, client, { runCli, runCliAsync },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(db.getLatestConvSummary("100")).not.toBeNull();
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
          asyncEnabled: false,
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCommand: async () => null, // always pass through
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
          asyncEnabled: false,
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
          asyncEnabled: false,
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
          asyncEnabled: false,
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

      const runCli = vi.fn().mockResolvedValue("***\nUse the Agy-specific response.");
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "health",
          executionKind: "antigravity",
          botConfig: { command: "agy", modelPreference: ["gemini-3-pro-preview"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
      expect(args).not.toContain("--output-format");
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
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) return "Error: timed out waiting for response";
        return "***\nRecovered answer";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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

    it("retries recoverable Agy cascade errors once with a fresh conversation and recent context", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const capturedPrompts: string[] = [];
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(args);
        capturedPrompts.push(args[args.length - 1]);
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) {
          throw new Error('{"type":"error","message":"error executing cascade step: CORTEX_STEP_TYPE_GREP_SEARCH: grep: -r: No such file or directory: exit status 2"}');
        }
        return "***\nRecovered after reset";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
        if (runCli.mock.calls.length === 1) return "***\nPrior answer from Agy";
        if (runCli.mock.calls.length === 2) {
          throw new Error("Agy stalled in planner loop without usable output");
        }
        return "***\nRecovered from stall";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
        if (runCli.mock.calls.length === 1) return "***\nPrior answer";
        if (runCli.mock.calls.length === 2) {
          throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command abc/task-22 not Found");
        }
        return "***\nRecovered command status error";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
        if (runCli.mock.calls.length === 1) return "***\nPrior answer";
        if (runCli.mock.calls.length <= 3) {
          throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command abc/task-18 not found");
        }
        return "***\nRecovered on second fresh retry";
      });
      const client = makeMockClient();
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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

    it.each(["sync", "async"] as const)("commits a recoverable Agy fresh-session retry exactly once in %s mode", async (mode) => {
      const { BridgeEngine } = await import("../src/engine.js");
      const memorySidecar = [
        "Recovered exactly once.",
        "<!-- agent-bridge-memory",
        JSON.stringify([{ type: "decision", scope: "project", text: `Agy ${mode} recovery commits one memory candidate.`, confidence: 0.9 }]),
        "-->",
      ].join("\n");
      let calls = 0;
      const execute = vi.fn().mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return "***\nPrior answer";
        if (calls === 2) throw new Error("error executing cascade step: CORTEX_STEP_TYPE_COMMAND_STATUS: command retry/task not found");
        return `***\n${memorySidecar}`;
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
          asyncEnabled: mode === "async",
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
          hooks: { onAfterExecute },
        },
        db,
        client,
        mode === "async"
          ? { runCliAsync: async (...args: any[]) => ({ text: await execute(...args) }) }
          : { runCli: execute },
      );

      db.setSession("100", "antigravity", "stale-conversation");
      await engine.handleMessages([makeMessage("first question")]);
      const turnsBeforeRetry = db.raw.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE chat_key = '100'").get() as { count: number };
      const memoriesBeforeRetry = db.getMemoryCount();
      onAfterExecute.mockClear();

      await engine.handleMessages([makeMessage("second question")]);

      const turnsAfterRetry = db.raw.prepare("SELECT COUNT(*) AS count FROM conversation_turns WHERE chat_key = '100'").get() as { count: number };
      expect(turnsAfterRetry.count - turnsBeforeRetry.count).toBe(2);
      expect(db.getMemoryCount() - memoriesBeforeRetry).toBe(1);
      expect(onAfterExecute).toHaveBeenCalledOnce();
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toBe("Recovered exactly once.");
    });

    it("surfaces a friendly error instead of the raw cascade error when all fresh retries fail", async () => {
      const { BridgeEngine } = await import("../src/engine.js");

      const runCli = vi.fn().mockImplementation(async () => {
        if (runCli.mock.calls.length === 1) return "***\nPrior answer";
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
          asyncEnabled: false,
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
          allowedUserIds: new Set(["99999"]), // only 99999 allowed
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello", 42)]); // from user 42, not allowed

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
          // Externally-held synthetic lock, no real process to abort — pin
          // queue mode so this FIFO-notification test isn't affected by the
          // Issue #177 interrupt default.
          busyMessageMode: "queue",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleUpdate({
        update_id: 1,
        message: makeMessage("/stop"),
      });

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
          asyncEnabled: false,
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

      // Hold the lock externally to simulate an in-flight execution
      db.acquireLock("test", "100");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          // Pinned explicitly: this test validates durable-FIFO queue
          // accounting, not busy-mode admission (Issue #177).
          busyMessageMode: "queue",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      await engine.handleMessages([makeMessage("queued message")]);

      // Issue #229: plain FIFO queueing is silent — no status message —
      // but the row must still be durably queued.
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(db.pendingMsgCount("test", "100")).toBe(1);
    });

    it("pending queue survives engine re-instantiation", () => {
      // This test verifies the queue is now backed by SQLite, not an in-memory Map.
      // After a new engine instance is created with the same db, the queued message
      // should be visible.
      db.acquireLock("test", "chat:1");
      db.enqueueMsg("test", "chat:1", { prompt: "hello", chatId: 1, chatType: "private" });
      // Simulate engine restart: new instance, same db
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
        executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: firstRun });
      const claude = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:claude",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
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
        executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
      }, db, makeMockClient(), { runCli: firstRun });
      const topic8 = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
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
      // busyMessageMode pinned to "queue": these mocked runCli implementations
      // never register a real killable child process, so interrupt mode has
      // nothing to abort and would otherwise just block on natural
      // completion — this test is about FIFO queue mechanics, not that.
      const first = new BridgeEngine({
        kind: "codex", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", asyncEnabled: false, pollIntervalMs: 1000,
      }, db, firstClient, { runCli: firstRun });
      const second = new BridgeEngine({
        kind: "claude", surfaceIdentity: "telegram:interactive",
        botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "queue", asyncEnabled: false, pollIntervalMs: 1000,
      }, db, secondClient, { runCli: secondRun });

      const firstTask = first.handleMessages([makePrivateTopicMessage("first", 7)]);
      await firstStarted;
      await second.handleMessages([makePrivateTopicMessage("second", 7)]);

      expect(secondRun).not.toHaveBeenCalled();
      // Issue #229: plain FIFO queueing is silent — no status message —
      // but the row must still be durably queued.
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
        executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
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
          asyncEnabled: true,
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
          asyncEnabled: false,
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCapacityExhausted: async (chatKey) => { exhaustedChats.push(chatKey); },
          },
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onCapacityExhausted: exhaustedCalled,
          },
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
          asyncEnabled: false,
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
      // Regression: retry must not wrap the prompt in a second context block
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
          asyncEnabled: false,
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
      // The invalid-session catch block clears the session and recurses with
      // sessionId: null — under handoff_once that null session is exactly the
      // condition that forces injection, independent of any handoff mark.
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
          botConfig: {
            command: "claude",
            modelPreference: ["claude-sonnet-4-6", "claude-opus-4-7"]
          },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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

  // ── Topic-aware /stop and session storage ───────────────────────────────────

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
          asyncEnabled: false,
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
          asyncEnabled: false,
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
        message: {
          message_id: 123,
          chat: { id: 100, type: "supergroup" },
          message_thread_id: 7,
        },
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

      // chatId=100, threadId=7 → topic-aware key is "100:7"
      const threadKey = "100:7";
      db.acquireLock("test", threadKey); // hold lock to force queueing

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          // Externally-held synthetic lock, no real process to abort — pin
          // queue mode so this FIFO-notification test isn't affected by the
          // Issue #177 interrupt default.
          busyMessageMode: "queue",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      // Queue first message → position 1. Issue #229: queueing is silent —
      // assert the durable position via the db, not a status message.
      await engine.handleMessages([makeGroupMessage("first message")]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(1);

      client.sendMessage.mockClear();

      // /stop should clear the topic-aware queue
      await engine.handleUpdate({ update_id: 2, message: makeGroupMessage("/stop") });
      expect(db.pendingMsgCount("test", threadKey)).toBe(0);

      client.sendMessage.mockClear();

      // Next queued message must land at position 1 again — not 2 — proving queue was cleared
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
          // Externally-held synthetic lock, no real process to abort — pin
          // queue mode so this FIFO-notification test isn't affected by the
          // Issue #177 interrupt default.
          busyMessageMode: "queue",
          asyncEnabled: false,
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

  // ── Thread vs non-thread parity ──────────────────────────────────────────────

  describe("thread vs non-thread parity", () => {
    it("replaces a stale Agy conversation only under the originating topic key", async () => {
      process.env.ANTIGRAVITY_OUTPUT_MODE = "json";
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const staleId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const replacementId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
      const topicKey = "100:7";
      db.setSession(topicKey, "antigravity", staleId);
      const capturedArgs: string[][] = [];
      const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        capturedArgs.push(args);
        return JSON.stringify({
          conversation_id: replacementId,
          status: "SUCCESS",
          response: "native topic response",
        });
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
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
      expect(client.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_id: 100,
          message_thread_id: 7,
          text: expect.stringContaining("native topic response"),
        }),
      );
    });

    it("stores session under flat chatId for private chat messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const rawOutput = JSON.stringify({ result: "done", session_id: "private-session-xyz" });

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
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
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      // Private chat: makeMessage uses chat.type = "private", no message_thread_id
      await engine.handleMessages([makeMessage("hello from private")]);

      const flatKey = "100";
      expect(db.getSession(flatKey, "claude")).toBe("private-session-xyz");
      // No thread-scoped key must be set
      expect(db.getSession("100:undefined:42", "claude")).toBeNull();
    });

    it("private chat /stop clears the queue for the flat chat key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const flatKey = "100";
      db.acquireLock("test", flatKey); // hold lock to force queueing

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          // Externally-held synthetic lock, no real process to abort — pin
          // queue mode so this FIFO-notification test isn't affected by the
          // Issue #177 interrupt default.
          busyMessageMode: "queue",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      // Queue a private-chat message — should sit at position 1. Issue #229:
      // queueing is silent — assert the durable position via the db.
      await engine.handleMessages([makeMessage("first message")]);
      expect(db.pendingMsgCount("test", flatKey)).toBe(1);

      client.sendMessage.mockClear();

      // /stop in the same private chat clears the queue
      await engine.handleUpdate({ update_id: 2, message: makeMessage("/stop") });
      expect(db.pendingMsgCount("test", flatKey)).toBe(0);

      client.sendMessage.mockClear();

      // Next message after stop must land at position 1, not 2
      await engine.handleMessages([makeMessage("second message")]);
      expect(db.pendingMsgCount("test", flatKey)).toBe(1);
      expect(client.sendMessage.mock.calls.some((c: any[]) => c[0]?.text?.includes("Queued"))).toBe(false);
    });

    it("two messages in the same thread queue behind each other", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const threadKey = "100:7";
      db.acquireLock("test", threadKey); // hold lock

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          // Externally-held synthetic lock, no real process to abort — pin
          // queue mode so this FIFO-notification test isn't affected by the
          // Issue #177 interrupt default.
          busyMessageMode: "queue",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        {},
      );

      // First message in thread 7 → queued at position 1. Issue #229:
      // queueing is silent — assert the durable position via the db.
      await engine.handleMessages([makeGroupMessage("msg one", 42, 100, 7)]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(1);

      // Second message in the same thread 7 → queued at position 2
      await engine.handleMessages([makeGroupMessage("msg two", 42, 100, 7)]);
      expect(db.pendingMsgCount("test", threadKey)).toBe(2);
      expect(client.sendMessage.mock.calls.some((c: any[]) => c[0]?.text?.includes("Queued"))).toBe(false);
    });

    it("a message in a different thread is not blocked by a lock held in thread 7", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Hold lock only for thread 7
      const thread7Key = "100:7";
      db.acquireLock("test", thread7Key);

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
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
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      // Message in thread 8 has a different key ("100:8") — should NOT be queued
      await engine.handleMessages([makeGroupMessage("msg in thread 8", 42, 100, 8)]);

      // runCli must have been called (not queued)
      expect(runCliAsync).toHaveBeenCalledOnce();

      // No "Queued" message should have been sent
      const queuedMsg = client.sendMessage.mock.calls.find((c: any[]) => c[0]?.text?.includes("Queued"));
      expect(queuedMsg).toBeUndefined();
    });
  });

  describe("session stored under topic-aware key after execution", () => {
    it("stores session under chatId:threadId for supergroup topic messages", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Claude --output-format json produces { result, session_id }
      const rawOutput = JSON.stringify({ result: "done", session_id: "thread-session-abc" });

      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
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
          asyncEnabled: true,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCliAsync },
      );

      await engine.handleMessages([makeGroupMessage("hello from thread")]);

      // Session must be stored under topic-aware key, not flat chatId
      const threadKey = "100:7";
      const flatKey = "100";
      expect(db.getSession(threadKey, "claude")).toBe("thread-session-abc");
      expect(db.getSession(flatKey, "claude")).toBeNull();
    });

    it("drains queued supergroup topic messages with the original topic key", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const rawOutput = JSON.stringify({ result: "done", session_id: "queued-topic-session" });
      const runCliAsync = vi.fn().mockImplementation(async (
        _command: string,
        _args: string[],
        _cwd: string,
        options: any,
      ) => {
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
          asyncEnabled: true,
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          hooks: {
            onAfterExecute: afterExecute,
          },
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

    it("stores post-turn memory sidecars and strips them from delivery and history", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue([
        "Visible answer.",
        "",
        "<!-- agent-bridge-memory",
        JSON.stringify([
          {
            type: "decision",
            scope: "project",
            text: "Agent Bridge stores memory sidecars after successful turns.",
            confidence: 0.81,
          },
        ]),
        "-->",
      ].join("\n"));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("finish phase four")]);

      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("Visible answer.");
      expect(sentBody.text).not.toContain("agent-bridge-memory");
      expect(db.searchMemories("memory sidecars successful turns").some((m) => m.text.includes("memory sidecars"))).toBe(true);
      expect(db.buildConvContext("100")).toContain("Visible answer.");
      expect(db.buildConvContext("100")).not.toContain("agent-bridge-memory");
    });

    it("exposes memory context helper on a chat's first turn when project memories exist", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      db.addMemory({
        id: "mem_first_turn",
        type: "decision",
        scope: "project",
        text: "First-turn prompts still need access to durable project memory.",
      });
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue("Visible answer.");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("first message in this chat", 42, 999)]);

      const promptArg = runCli.mock.calls[0][1].at(-1);
      expect(promptArg).toContain("AGENT_BRIDGE_CONTEXT_COMMAND");
      expect(promptArg).toContain("--memory");
    });

    it("passes the BridgeDb abstraction to project memory storage", async () => {
      const candidate = {
        type: "decision",
        scope: "project",
        text: "Engine forwards project memory writes through BridgeDb.",
      };
      const storeProjectMemoryCandidate = vi.fn().mockReturnValue({ status: "stored", id: "mem_test" });
      vi.resetModules();
      vi.doMock("../src/projectMemory.js", () => ({
        extractProjectMemorySidecars: vi.fn().mockReturnValue({
          cleanText: "Visible answer.",
          candidates: [candidate],
        }),
        storeProjectMemoryCandidate,
      }));

      try {
        const { BridgeEngine } = await import("../src/engine.js");
        const client = makeMockClient();
        const runCli = vi.fn().mockResolvedValue("Visible answer with sidecar.");

        const engine = new BridgeEngine(
          {
            surfaceIdentity: "test",
            kind: "claude",
            botConfig: { command: "claude", modelPreference: [] },
            allowedUserIds: new Set(["42"]),
            executionMode: "safe",
            asyncEnabled: false,
            pollIntervalMs: 1000,
            fullConfig: makeFullConfig(dbPath),
          },
          db,
          client,
          { runCli },
        );

        await engine.handleMessages([makeMessage("remember through db")]);

        expect(storeProjectMemoryCandidate).toHaveBeenCalledWith(db, candidate, expect.objectContaining({
          chatKey: "100",
          cliKind: "claude",
        }));
      } finally {
        vi.doUnmock("../src/projectMemory.js");
        vi.resetModules();
      }
    });

    it("rejects secret-looking post-turn memory sidecars", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn().mockResolvedValue([
        "Visible answer.",
        "",
        "<!-- agent-bridge-memory",
        JSON.stringify([
          {
            type: "decision",
            scope: "project",
            text: "API_KEY=abc123 should never become durable memory.",
          },
        ]),
        "-->",
      ].join("\n"));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("finish phase four safely")]);

      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("Visible answer.");
      expect(sentBody.text).not.toContain("agent-bridge-memory");
      expect(db.searchMemories("API_KEY abc123")).toEqual([]);
    });

    it("does not run post-turn memory extraction after a normal turn (compact is the sole distillation path)", async () => {
      process.env.BRIDGE_MEMORY_EXTRACTOR_ENABLED = "1";
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      const runCli = vi.fn()
        .mockResolvedValueOnce("Visible answer about fixing memory health.")
        .mockResolvedValueOnce(JSON.stringify([
          {
            type: "decision",
            scope: "project",
            text: "Agent Bridge automatically extracts durable project memories after successful turns.",
            confidence: 0.88,
          },
        ]));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("fix memory health")]);

      // Only the primary CLI call should run; no second call for post-turn extraction,
      // even with the legacy env flag set — the extractor no longer exists.
      expect(runCli).toHaveBeenCalledTimes(1);
      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toBe("Visible answer about fixing memory health.");
      expect(db.searchMemories("automatically extracts durable project memories")).toEqual([]);
    });
  });

  describe("/compact command", () => {
    it("compacts only the originating private topic and resets only its provider session", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100:7", "user", "topic seven private objective");
      db.addConvTurn("100:7", "assistant", "topic seven private response");
      db.addConvTurn("100:8", "user", "topic eight must remain isolated");
      db.addConvTurn("100:8", "assistant", "topic eight private response");
      db.setSession("100:7", "claude", "session-topic-7");
      db.setSession("100:8", "claude", "session-topic-8");
      db.addMemory({
        id: "instance-global-memory",
        type: "decision",
        scope: "project",
        text: "Project memory remains instance-global across Telegram topics.",
      });
      const memoryCountBefore = db.getMemoryCount();
      let capturedPrompt = "";
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = String(args.at(-1));
        return compactJson("Current objective:\n- topic seven only\n\nDurable facts:\n- none\n\nOpen state:\n- none");
      });
      const engine = new BridgeEngine({
        kind: "claude",
        surfaceIdentity: "telegram:interactive",
        botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1000,
      }, db, client, { runCli });

      await engine.handleMessages([makePrivateTopicMessage("/compact", 7)]);

      expect(capturedPrompt).toContain("topic seven private objective");
      expect(capturedPrompt).not.toContain("topic eight must remain isolated");
      // Issue #349: turns are retained as recoverable evidence, not deleted;
      // bounded compaction backlog is empty since the summary covers them.
      expect(db.getRecentConvTurns("100:7", 10).map((turn) => turn.text)).toEqual([
        "topic seven private objective", "topic seven private response",
      ]);
      expect(db.getConvTurnsForCompaction("100:7")).toEqual([]);
      expect(db.getRecentConvTurns("100:8", 10).map((turn) => turn.text)).toEqual([
        "topic eight must remain isolated", "topic eight private response",
      ]);
      expect(db.getLatestConvSummary("100:7")?.summary_md).toContain("topic seven only");
      expect(db.getLatestConvSummary("100:8")).toBeNull();
      expect(db.getSession("100:7", "claude")).toBeNull();
      expect(db.getSession("100:8", "claude")).toBe("session-topic-8");
      expect(db.getMemoryCount()).toBe(memoryCountBefore);
      expect(db.searchMemories("instance-global Telegram topics")).toHaveLength(1);
    });

    it("compact handler calls runCli for LLM summary and stores result", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "fix the auth bug");
      db.addConvTurn("100", "assistant", "on it");

      let capturedPrompt: string | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        // For claude bot, the prompt is the last argument
        capturedPrompt = args[args.length - 1];
        return compactJson("Current objective:\n- fix auth bug\n\nDurable facts:\n- none\n\nOpen state:\n- none");
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      const summary = db.getLatestConvSummary("100");
      expect(summary).not.toBeNull();
      expect(summary!.summary_md).toContain("fix auth bug");
      expect(capturedPrompt).toContain("Current objective:");
      expect(client.sendMessage.mock.calls[0]?.[0].text).toContain("Compacting context");
      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("Session reset");
      expect(sentBody.text).not.toContain("turn count, CLI, last message");
      expect(db.getSetting("compact_in_progress:100")).toBeNull();
    });

    it("uses the configured recovery chain through the real manual engine path", async () => {
      process.env.BRIDGE_COMPACTION_CHAIN = "codex:gpt-manual-fallback";
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "recover manual compaction");

      const commands: string[] = [];
      const runCli = vi.fn().mockImplementation(async (command: string) => {
        commands.push(command);
        if (command === "claude") throw new Error("Authentication required: please log in");
        return codexCompactEvents(compactJson("Current objective:\n- manual fallback\n\nDurable facts:\n- none\n\nOpen state:\n- none"));
      });
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-primary"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: makeFullConfig(dbPath),
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(commands).toEqual(["claude", "codex"]);
      expect(db.getLatestConvSummary("100")?.summary_md).toContain("manual fallback");
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?")
        .get("100")).toEqual({ count: 1 });
      expect(db.getLatestCompactionAttempt("100")).toEqual(expect.objectContaining({
        trigger: "manual",
        provider: "codex",
        model: "gpt-manual-fallback",
        outcome: "compacted",
        cli_call_count: 2,
      }));
    });

    it("reports an existing compact run instead of starting a duplicate", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "hello");
      db.setSetting("compact_in_progress:100", "2026-06-27T13:35:20.000Z");

      const runCli = vi.fn().mockResolvedValue("should not run");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(runCli).not.toHaveBeenCalled();
      expect(client.sendMessage.mock.calls.at(-1)?.[0].text).toContain("Compact already in progress");
    });

    it("summarises compact chunks with bounded parallelism", async () => {
      vi.resetModules();
      process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS = "120";
      process.env.BRIDGE_COMPACT_PARALLELISM = "2";
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      for (let i = 0; i < 8; i++) {
        db.addConvTurn("100", "user", `turn-${i} ${"x".repeat(80)}`);
      }

      let active = 0;
      let maxActive = 0;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const prompt = args[args.length - 1];
        if (prompt.includes("Merge these compact summaries")) {
          return compactJson("Current objective:\n- reduced\n\nDurable facts:\n- none\n\nOpen state:\n- none");
        }
        return compactJson("Current objective:\n- chunk\n\nDurable facts:\n- none\n\nOpen state:\n- none");
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(maxActive).toBe(2);
      expect(runCli.mock.calls.length).toBeGreaterThan(2);
    });

    it("compact failure is non-destructive when runCli fails: no summary stored, turns preserved", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "hello");
      db.addConvTurn("100", "assistant", "hi there");

      const runCli = vi.fn().mockRejectedValue(new Error("CLI timeout"));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(db.getLatestConvSummary("100")).toBeNull();
      expect(db.getRecentConvTurns("100", 100)).toHaveLength(2);
      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("Compaction failed");
      expect(db.getSetting("compact_in_progress:100")).toBeNull();
    });

    it("compact failure is non-destructive when the CLI returns non-JSON or JSON missing summary_md", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "malformed response test");
      db.addConvTurn("100", "assistant", "ack");

      const runCli = vi.fn().mockResolvedValue("Sure! Here is a summary of the conversation in prose form.");

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      // Non-JSON output is a failure, not a stored result — no summary, turns preserved.
      expect(db.getLatestConvSummary("100")).toBeNull();
      expect(db.getRecentConvTurns("100", 100)).toHaveLength(2);
      const sentBody = client.sendMessage.mock.calls.at(-1)?.[0];
      expect(sentBody.text).toContain("Compaction failed");
    });

    it("uses the companion compact profile when configured", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "remind me about my training plan");
      db.addConvTurn("100", "assistant", "sure, noted");

      let capturedPrompt: string | undefined;
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedPrompt = args[args.length - 1];
        return compactJson("Current objective:\n- track training plan\n\nDurable facts:\n- none\n\nOpen state:\n- none");
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          compactProfile: "companion",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(capturedPrompt).toContain("preferences");
      const summary = db.getLatestConvSummary("100");
      expect(summary?.summary_md).toContain("track training plan");
    });

    it("compact retains raw turns up to endId as recoverable evidence after storing the summary (issue #349)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "first");
      db.addConvTurn("100", "assistant", "second");
      db.addConvTurn("100", "user", "third");

      const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- done\n\nDurable facts:\n- none\n\nOpen state:\n- none"));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      // Issue #349: all 3 turns are retained as recoverable evidence, not
      // pruned, even though the summary covers them.
      const remaining = db.getRecentConvTurns("100", 100);
      expect(remaining.length).toBe(3);
      // Bounded compaction backlog is empty since the summary covers them.
      expect(db.getConvTurnsForCompaction("100")).toEqual([]);
      // Summary still exists
      expect(db.getLatestConvSummary("100")).not.toBeNull();
    });

    it("compact chunks histories over 1000 turns and retains the full covered range as evidence (issue #349)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      for (let i = 0; i < 1005; i++) {
        db.addConvTurn("100", i % 2 === 0 ? "user" : "assistant", `turn-${i}`);
      }

      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        capturedPrompts.push(prompt);
        if (prompt.includes("Merge these compact summaries")) {
          return compactJson("Current objective:\n- reduced all chunks\n\nDurable facts:\n- all 1005 turns covered\n\nOpen state:\n- none");
        }
        return compactJson(`Current objective:\n- chunk ${capturedPrompts.length}\n\nDurable facts:\n- ${prompt.includes("turn-0") ? "includes first turn" : "later chunk"}\n\nOpen state:\n- none`);
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      expect(runCli.mock.calls.length).toBeGreaterThan(1);
      expect(capturedPrompts[0]).toContain("turn-0");
      expect(capturedPrompts.at(-1)).toContain("Merge these compact summaries");
      // Issue #349: all 1005 turns are retained as recoverable evidence, not
      // pruned; bounded compaction backlog is empty since the summary covers
      // the full range.
      expect(db.getRecentConvTurns("100", 2000)).toHaveLength(1005);
      expect(db.getConvTurnsForCompaction("100")).toEqual([]);
      const summary = db.getLatestConvSummary("100");
      expect(summary?.summary_md).toContain("all 1005 turns covered");
      expect(summary?.range_start_turn_id).toBe(1);
      expect(summary?.range_end_turn_id).toBe(1005);
    });

    it("compact clears the CLI session so next prompt starts a fresh session seeded with the summary", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.addConvTurn("100", "user", "we are halfway through a big refactor");
      db.addConvTurn("100", "assistant", "understood, continuing");
      db.setSession("100", "claude", "existing-session-abc");

      const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- big refactor\n\nDurable facts:\n- none\n\nOpen state:\n- none"));

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/compact")]);

      // Session must be cleared so the next execution starts a fresh CLI session
      expect(db.getSession("100", "claude")).toBeNull();
      // Summary must still be stored
      const summary = db.getLatestConvSummary("100");
      expect(summary).not.toBeNull();
      expect(summary!.summary_md).toContain("big refactor");
    });
  });

  describe("Agent Bridge context helper affordance", () => {
    it("injects helper env and prompt affordance when stored context exists", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();
      db.addConvTurn("100", "user", "remember work item #16", "claude");
      db.addConvSummary("100", 1, 1, "Current objective:\n- Keep context available.");

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
          asyncEnabled: false,
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
      // Issue #350: handoff guidance also advertises scoped older-evidence
      // search, alongside (not instead of) the existing recent-turn window.
      expect(capturedPrompt).toContain("--search");
      expect(capturedPrompt).toContain("Current objective:");
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
          asyncEnabled: false,
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
    it("deletes conversation turns and summaries only for the reset conversation", async () => {
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
      );

      await engine.handleMessages([makeMessage("/reset")]);

      expect(db.getConvStatus("100", "test").turnCount).toBe(0);
      expect(db.getLatestConvSummary("100")).toBeNull();
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
          asyncEnabled: false,
          pollIntervalMs: 1000,
          soulContext: "Identity: Weaver",
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("/reset")]);
      await engine.handleMessages([makeMessage("hello after reset")]);

      // Summary must NOT be injected into the first prompt after reset
      expect(capturedPrompt).not.toContain("Current objective:");
      expect(capturedPrompt).not.toContain("Soul contract:");
      expect(capturedPrompt).not.toContain("Active model:");
      expect(capturedPrompt).toContain("hello after reset");
    });
  });

  // ── Sync path parity with async path (effort + outputFormat) ─────────────────
  //
  // executePrompt (asyncEnabled=false) was missing both `effort` and
  // `outputFormat` from its buildCliInvocation call, unlike executePromptAsync.
  // These tests lock the expected parity so the regression cannot recur.

  describe("sync path (asyncEnabled: false) CLI argument parity with async path", () => {
    it("passes effort setting to CLI args for Claude bot (sync path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Store a non-default effort level so we can detect it in the CLI args.
      db.setSetting("effort:claude", "high");

      const capturedArgs: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(...args);
        return "response";
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(runCli).toHaveBeenCalledOnce();
      // Claude effort maps to --effort <level> prepended by appendEffortArgs.
      const effortIdx = capturedArgs.indexOf("--effort");
      expect(effortIdx).not.toBe(-1);
      expect(capturedArgs[effortIdx + 1]).toBe("high");
    });

    it("passes effort setting to CLI args for Codex bot (sync path)", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      db.setSetting("effort:codex", "high");

      const capturedArgs: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(...args);
        return "";
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(runCli).toHaveBeenCalledOnce();
      // Codex effort maps to -c model_reasoning_effort="<level>".
      const configIdx = capturedArgs.indexOf("-c");
      expect(configIdx).not.toBe(-1);
      expect(capturedArgs[configIdx + 1]).toMatch(/model_reasoning_effort="high"/);
    });

    it("passes stream-json output to Claude bot in sync continuation path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const capturedArgs: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(...args);
        return "";
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(runCli).toHaveBeenCalledOnce();
      const outputFormatIdx = capturedArgs.indexOf("--output-format");
      expect(outputFormatIdx).not.toBe(-1);
      expect(capturedArgs[outputFormatIdx + 1]).toBe("stream-json");
      expect(capturedArgs).toContain("--verbose");
    });

    it("passes --json flag to Codex bot in sync path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const capturedArgs: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(...args);
        return "";
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "codex",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(runCli).toHaveBeenCalledOnce();
      // outputFormat="json" maps to --json for Codex.
      expect(capturedArgs).toContain("--json");
    });

    it("does NOT pass --output-format to antigravity bot in sync path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      const capturedArgs: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        capturedArgs.push(...args);
        return "***\nAgy response";
      });

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "antigravity",
          botConfig: { command: "agy", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      expect(runCli).toHaveBeenCalledOnce();
      expect(capturedArgs).not.toContain("--output-format");
    });

    it("captures session ID from structured JSON output in sync Claude path", async () => {
      const { BridgeEngine } = await import("../src/engine.js");
      const client = makeMockClient();

      // Claude --output-format json outputs a JSON object with result and session_id.
      const rawOutput = JSON.stringify({ result: "Here is my answer", session_id: "sync-session-xyz" });
      const runCli = vi.fn().mockResolvedValue(rawOutput);

      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          asyncEnabled: false,
          pollIntervalMs: 1000,
        },
        db,
        client,
        { runCli },
      );

      await engine.handleMessages([makeMessage("hello")]);

      // Without outputFormat="json" the CLI outputs plain text and
      // parseClaudeResult falls back to sessionId: null, breaking continuity.
      expect(db.getSession("100", "claude")).toBe("sync-session-xyz");
    });
  });
});
