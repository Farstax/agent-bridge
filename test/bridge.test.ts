import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecutionOptions,
  isAuthorizedMessage,
  extractPromptText,
  buildCliInvocation,
  parseCliResult,
  handleCommand,
  isBridgeCommand,
  getBridgeProjectDir,
  getCliWorkingDir,
  validateBridgeConfig,
  buildModelKeyboard,
  buildModelsText,
  buildTelegramCommands,
  extractAntigravityConversationId,
  readAntigravityLastConversation,
  readLatestAntigravityConversationFromLogs,
  resolveAntigravityConversationId,
  ensureAntigravityStateDirs,
} from "../src/bridge.js";
import { openDb, BridgeDb } from "../src/db.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";
import type { TelegramMessage, BridgeConfig } from "../src/types.js";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";

describe("agent bridge MVP", () => {
  it("authorizes only the configured telegram user id", () => {
    const allowed = new Set(["42"]);
    const msg = { from: { id: 42 } } as any as TelegramMessage;
    expect(isAuthorizedMessage(msg, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 7 } } as any, allowed)).toBe(false);
    expect(isAuthorizedMessage({} as any, allowed)).toBe(false);
  });

  it("authorizes multiple allowed user ids", () => {
    const allowed = new Set(["10", "20", "30"]);
    expect(isAuthorizedMessage({ from: { id: 10 } } as any, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 20 } } as any, allowed)).toBe(true);
    expect(isAuthorizedMessage({ from: { id: 99 } } as any, allowed)).toBe(false);
  });

  it("extracts plain message text", () => {
    expect(extractPromptText({ text: "hello" } as any)).toBe("hello");
    expect(extractPromptText({ text: "   " } as any)).toBeNull();
    expect(extractPromptText({ text: "/start" } as any)).toBeNull();
    expect(extractPromptText({} as any)).toBeNull();
  });

  it("recognizes supported bridge commands", () => {
    expect(isBridgeCommand("/start")).toBe(true);
    expect(isBridgeCommand("/models")).toBe(true);
    expect(isBridgeCommand("/effort")).toBe(true);
    expect(isBridgeCommand("/skills")).toBe(true);
    expect(isBridgeCommand("/memory")).toBe(false);
    expect(isBridgeCommand("/usage")).toBe(true);
    expect(isBridgeCommand("/queue_mode")).toBe(true);
    expect(isBridgeCommand("hello")).toBe(false);
  });

  it("recognizes @botname-suffixed commands (group usage)", () => {
    expect(isBridgeCommand("/start@mybot")).toBe(true);
    expect(isBridgeCommand("/reset@AnotherBot")).toBe(true);
    expect(isBridgeCommand("/models@somebot")).toBe(true);
    expect(isBridgeCommand("/skills@somebot")).toBe(true);
    expect(isBridgeCommand("/usage@somebot")).toBe(true);
    expect(isBridgeCommand("/unknown@mybot")).toBe(false);
  });

  it("creates fresh codex invocation using exec subcommand", () => {
    const { command, args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
    });
    expect(command).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args.at(-1)).toContain("hello");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).not.toContain("--thread");
    expect(args).not.toContain("--output");
  });

  it("uses the bot-specific project dir when BRIDGE_PROJECT_DIR is not enough", () => {
    const prevBridgeRoot = process.env.BRIDGE_ROOT_DIR;
    const prevCodexProjectDir = process.env.CODEX_PROJECT_DIR;
    const prevAntigravityProjectDir = process.env.ANTIGRAVITY_PROJECT_DIR;

    const prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

    process.env.BRIDGE_ROOT_DIR = "/tmp/bridge-root";
    process.env.CODEX_PROJECT_DIR = "/tmp/codex-repo";
    process.env.ANTIGRAVITY_PROJECT_DIR = "/tmp/antigravity-repo";
    process.env.CLAUDE_PROJECT_DIR = "/tmp/claude-repo";

    expect(getCliWorkingDir("codex")).toBe("/tmp/codex-repo");
    expect(getCliWorkingDir("antigravity")).toBe("/tmp/antigravity-repo");
    expect(getCliWorkingDir("claude")).toBe("/tmp/claude-repo");

    if (prevBridgeRoot === undefined) delete process.env.BRIDGE_ROOT_DIR; else process.env.BRIDGE_ROOT_DIR = prevBridgeRoot;
    if (prevCodexProjectDir === undefined) delete process.env.CODEX_PROJECT_DIR; else process.env.CODEX_PROJECT_DIR = prevCodexProjectDir;
    if (prevAntigravityProjectDir === undefined) delete process.env.ANTIGRAVITY_PROJECT_DIR; else process.env.ANTIGRAVITY_PROJECT_DIR = prevAntigravityProjectDir;
    if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
  });

  it("keeps deprecated GEMINI_PROJECT_DIR alias for antigravity cwd compatibility", () => {
    const prevBridgeProject = process.env.BRIDGE_PROJECT_DIR;
    const prevBridgeRoot = process.env.BRIDGE_ROOT_DIR;
    const prevAntigravityProjectDir = process.env.ANTIGRAVITY_PROJECT_DIR;
    const prevGeminiProjectDir = process.env.GEMINI_PROJECT_DIR;

    process.env.BRIDGE_PROJECT_DIR = "/tmp/bridge-project";
    process.env.BRIDGE_ROOT_DIR = "/tmp/bridge-root";
    delete process.env.ANTIGRAVITY_PROJECT_DIR;
    process.env.GEMINI_PROJECT_DIR = "/tmp/gemini-repo";

    expect(getCliWorkingDir("antigravity")).toBe("/tmp/gemini-repo");

    if (prevBridgeProject === undefined) delete process.env.BRIDGE_PROJECT_DIR; else process.env.BRIDGE_PROJECT_DIR = prevBridgeProject;
    if (prevBridgeRoot === undefined) delete process.env.BRIDGE_ROOT_DIR; else process.env.BRIDGE_ROOT_DIR = prevBridgeRoot;
    if (prevAntigravityProjectDir === undefined) delete process.env.ANTIGRAVITY_PROJECT_DIR; else process.env.ANTIGRAVITY_PROJECT_DIR = prevAntigravityProjectDir;
    if (prevGeminiProjectDir === undefined) delete process.env.GEMINI_PROJECT_DIR; else process.env.GEMINI_PROJECT_DIR = prevGeminiProjectDir;
  });

  it("defaults the bridge project dir to the current working directory", () => {
    const prevBridgeProjectDir = process.env.BRIDGE_PROJECT_DIR;
    delete process.env.BRIDGE_PROJECT_DIR;

    expect(getBridgeProjectDir()).toBe(process.cwd());

    if (prevBridgeProjectDir === undefined) delete process.env.BRIDGE_PROJECT_DIR; else process.env.BRIDGE_PROJECT_DIR = prevBridgeProjectDir;
  });

  it("creates trusted codex invocation only when explicitly requested", () => {
    expect(
      buildCliInvocation({
        bot: "codex",
        prompt: "hello",
        sessionId: null,
        command: "codex",
        model: null,
        executionMode: "trusted",
      }).args,
    ).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("creates resume codex invocation using exec resume subcommand", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello again",
      sessionId: "019e1299-3d2c-7f11-8194-500feee6614e",
      command: "codex",
      model: null,
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).toContain("019e1299-3d2c-7f11-8194-500feee6614e");
    expect(args.at(-1)).toContain("hello again");
    expect(args).not.toContain("--thread");
  });

  it("codex json invocation uses --json flag not --output", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
      outputFormat: "json",
    });
    expect(args).toContain("--json");
    expect(args).not.toContain("--output");
  });

  it("wraps codex prompts with the minimum response contract when Soul is absent", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt).toContain("hello");
    expect(printedPrompt).toContain("Response contract:");
    expect(printedPrompt).toContain("Preserve critical facts");
    expect(printedPrompt).not.toContain("Keep replies extremely concise");
  });

  it("includes SOUL.md context in wrapped prompts when provided", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
      soulContext: "Identity: Chas\nValues: clarity before cleverness",
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt).toContain("Soul contract:");
    expect(printedPrompt).toContain("Identity: Chas");
    expect(printedPrompt).toContain("Values: clarity before cleverness");
    expect(printedPrompt).toContain("Response contract:");
    expect(printedPrompt).toContain("User request:");
  });

  it("uses Soul's configurable Communication Style instead of the fallback contract", () => {
    const { args } = buildCliInvocation({
      bot: "codex",
      prompt: "hello",
      sessionId: null,
      command: "codex",
      model: null,
      soulContext: "## Communication Style\nUse a warm paragraph.",
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt).toContain("Use a warm paragraph.");
    expect(printedPrompt).not.toContain("Response contract:");
  });

  it("creates fresh antigravity invocation with --print prompt after all flags", () => {
    const { command, args } = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "antigravity",
      model: "antigravity-pro",
      executionMode: "trusted",
    });
    expect(command).toBe("antigravity");
    expect(args).not.toContain("--model");
    expect(args.at(-2)).toBe("--print");
    expect(String(args.at(-1))).toContain("hello");
    expect(args.indexOf("--dangerously-skip-permissions")).toBeLessThan(args.indexOf("--print"));
  });

  it("wraps antigravity prompts with a JSON output instruction", () => {
    const { args } = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "antigravity",
      model: null,
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt).toContain("hello");
    expect(printedPrompt).toContain("Execute directly. Do not get stuck in planning loops.");
    expect(printedPrompt).toContain("If a tool, search, or shell step fails twice");
    expect(printedPrompt).toContain('"response"');
    expect(printedPrompt).not.toContain('"reasoning"');
  });

  it("keeps antigravity delimiter outside SOUL.md and Telegram style context", () => {
    const { args } = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "antigravity",
      model: null,
      soulContext: "Identity: Chas",
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt.indexOf("line containing only ***")).toBeLessThan(printedPrompt.indexOf("Soul contract:"));
    expect(printedPrompt.indexOf("Soul contract:")).toBeLessThan(printedPrompt.indexOf("User request:"));
  });

  it("antigravity session invocation uses --conversation to continue an existing session", () => {
    const { args } = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed",
      command: "antigravity",
      model: null,
    });
    expect(args).toContain("--conversation");
    expect(args[args.indexOf("--conversation") + 1]).toBe("4229bce3-5009-429e-a3cb-d1bdaa8cfeed");
    expect(args.indexOf("--conversation")).toBeLessThan(args.indexOf("--print"));
    expect(args.at(-2)).toBe("--print");
    expect(String(args.at(-1))).toContain("hello");
  });

  it("antigravity trusted execution mode adds --dangerously-skip-permissions", () => {
    const { args } = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "antigravity",
      model: null,
      executionMode: "trusted",
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("creates fresh claude invocation with --print flag", () => {
    const { command, args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
    });
    expect(command).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("--settings");
    const settings = JSON.parse(String(args[args.indexOf("--settings") + 1]));
    expect(settings.enabledPlugins["telegram@claude-plugins-official"]).toBe(false);
    expect(args.at(-1)).toContain("hello");
    expect(args).not.toContain("--resume");
  });

  it("wraps claude prompts with the minimum response contract when Soul is absent", () => {
    const { args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
    });

    const printedPrompt = String(args.at(-1));
    expect(printedPrompt).toContain("hello");
    expect(printedPrompt).toContain("Response contract:");
    expect(printedPrompt).toContain("Preserve critical facts");
    expect(printedPrompt).not.toContain("Keep replies extremely concise");
  });

  it("creates resume claude invocation with --resume flag", () => {
    const { args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: "sess-abc-123",
      command: "claude",
      model: null,
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-abc-123");
  });

  it("claude trusted mode uses --dangerously-skip-permissions", () => {
    const { args } = buildCliInvocation({
      bot: "claude",
      prompt: "hello",
      sessionId: null,
      command: "claude",
      model: null,
      executionMode: "trusted",
    });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("parses claude JSON output", () => {
    const stdout = JSON.stringify({
      type: "result", subtype: "success", session_id: "sess-123", result: "Hello from claude",
    });
    expect(parseCliResult({ bot: "claude", stdout })).toEqual({
      text: "Hello from claude",
      sessionId: "sess-123",
    });
  });

  it("parses claude plain text output when no JSON found", () => {
    expect(parseCliResult({ bot: "claude", stdout: "plain response" })).toEqual({
      text: "plain response",
      sessionId: null,
    });
  });

  it("kills the CLI process group on idle timeout", async () => {
    await expect(
      runCli(
        "sleep",
        ["10"],
        process.cwd(),
        { timeoutMs: 1000, idleTimeoutMs: 100, killGraceMs: 100, chatId: "bridge-idle-timeout" },
      ),
    ).rejects.toThrow(/CLI idle timeout/);
    expect(await shutdownCliProcessesAndWait()).toBe(0);
  });

  it("parses codex JSONL output with item.completed agent_message", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"abc-123"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello back"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "Hello back",
      sessionId: "abc-123",
    });
  });

  it("parses codex JSONL output with response.completed event", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"xyz-789"}',
      '{"type":"response.completed","output_text":"Final answer"}',
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout })).toEqual({
      text: "Final answer",
      sessionId: "xyz-789",
    });
  });

  it("parses antigravity output and extracts session ID from log content", () => {
    const stdout = "hello from antigravity";
    const logContent = "Created conversation 4229bce3-5009-429e-a3cb-d1bdaa8cfeed";
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
        logContent,
      }),
    ).toEqual({ text: "hello from antigravity", sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed" });
  });

  it("parses antigravity output and extracts session ID using alternative pattern", () => {
    const stdout = "hello";
    const logContent = "some text\nconversation=019e1299-3d2c-7f11-8194-500feee6614e\nmore text";
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
        logContent,
      }),
    ).toEqual({ text: "hello", sessionId: "019e1299-3d2c-7f11-8194-500feee6614e" });
  });

  it("returns null sessionId for antigravity if logContent does not contain any ID", () => {
    const stdout = "hello";
    const logContent = "no conversation pattern here";
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
        logContent,
      }),
    ).toEqual({ text: "hello", sessionId: null });
  });

  it("parses antigravity output and strips thinking steps/HUD before the separator line", () => {
    const stdout = [
      "I will start by checking the current permissions.",
      "📊 I. SYSTEM HUD",
      "STATE: 🟢 (IDLE)",
      "***",
      "Hello! How can I help you today?",
    ].join("\n");
    const logContent = "Created conversation 4229bce3-5009-429e-a3cb-d1bdaa8cfeed";
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
        logContent,
      }),
    ).toEqual({
      text: "Hello! How can I help you today?",
      sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed",
    });
  });

  it("parses antigravity output using the last final-answer separator", () => {
    const stdout = [
      "***",
      "Previous answer from resumed session.",
      "***",
      "Current answer from resumed session.",
    ].join("\n");
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
      }),
    ).toEqual({
      text: "Current answer from resumed session.",
      sessionId: null,
    });
  });

  it("throws an error if antigravity output indicates a print mode timeout", () => {
    const stdout = [
      "***",
      "Previous answer.",
      "I will run the tests...",
      "Error: timed out waiting for response",
    ].join("\n");
    expect(() =>
      parseCliResult({
        bot: "antigravity",
        stdout,
      }),
    ).toThrow(/timed out/);
  });

  it("throws an error if antigravity log content indicates a print mode timeout", () => {
    const stdout = [
      "***",
      "Previous answer.",
      "I will run the tests...",
    ].join("\n");
    const logContent = "Print mode: timed out after 45 polls";
    expect(() =>
      parseCliResult({
        bot: "antigravity",
        stdout,
        logContent,
      }),
    ).toThrow(/timed out/);
  });


  it("parses antigravity output and strips thinking steps/HUD using the 🧠 Memory Loaded: separator", () => {
    const stdout = [
      "I am going to check the application directory to see if `.AGENTS.md` exists to follow the boot sequence protocol.",
      "I will list the available permissions to find out which directories we can access.",
      "I will list the contents of the allowed scratch directory to look for `.AGENTS.md`.",
      "I will read `.AGENTS.md` to load long-term memory as required by PROTOCOL ZERO.",
      "📊 I. SYSTEM HUD",
      "STATE: 🟢 (IDLE)",
      "CONTEXT: Chat",
      "GATES: [Lint: ✅] | [Types: ✅] | [Security: ✅]",
      "",
      "🧠 Memory Loaded: 0 relevant constraints found.",
      "",
      "Hello.",
    ].join("\n");
    expect(
      parseCliResult({
        bot: "antigravity",
        stdout,
      }),
    ).toEqual({
      text: "Hello.",
      sessionId: null,
    });
  });

  it("extracts antigravity conversation IDs from canonical Agy log lines", () => {
    expect(extractAntigravityConversationId("Created conversation 860cd239-3028-4ab6-9590-300532a72cca")).toBe("860cd239-3028-4ab6-9590-300532a72cca");
    expect(extractAntigravityConversationId("Print mode: conversation=c107dfbd-181e-4cf0-a840-894662adee43, sending message")).toBe("c107dfbd-181e-4cf0-a840-894662adee43");
  });

  it("reads antigravity last conversation cache by cwd", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-home-"));
    try {
      const cacheDir = join(home, ".gemini", "antigravity-cli", "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "last_conversations.json"), JSON.stringify({
        "/repo": "c107dfbd-181e-4cf0-a840-894662adee43",
      }));
      expect(readAntigravityLastConversation({ cwd: "/repo", homeDir: home })).toBe("c107dfbd-181e-4cf0-a840-894662adee43");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("pre-creates the antigravity worktrees state dir", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-home-"));
    try {
      ensureAntigravityStateDirs(home);
      expect(existsSync(join(home, ".gemini", "antigravity-cli", "worktrees"))).toBe(true);
      // Idempotent: second call must not throw.
      ensureAntigravityStateDirs(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("creates the antigravity worktrees dir when building an agy invocation", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-home-"));
    try {
      buildCliInvocation({
        bot: "antigravity",
        prompt: "hello",
        sessionId: null,
        command: "agy",
        model: null,
        homeDir: home,
      });
      expect(existsSync(join(home, ".gemini", "antigravity-cli", "worktrees"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to recent antigravity CLI logs for session resolution", () => {
    const home = mkdtempSync(join(tmpdir(), "agy-home-"));
    try {
      const logDir = join(home, ".gemini", "antigravity-cli", "log");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, "cli-test.log"), "Print mode: conversation=b3ba6842-e571-4fd3-9dac-ce613b2f35c6, sending message");
      expect(readLatestAntigravityConversationFromLogs({ sinceMs: Date.now() - 1000, homeDir: home })).toBe("b3ba6842-e571-4fd3-9dac-ce613b2f35c6");
      expect(resolveAntigravityConversationId({
        cwd: "/missing",
        sinceMs: Date.now() - 1000,
        homeDir: home,
        allowSharedStateFallback: true,
      })).toBe("b3ba6842-e571-4fd3-9dac-ce613b2f35c6");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validates bridge config", () => {
    const result = validateBridgeConfig({
      allowedUserIds: new Set(),
      bots: { codex: { token: null, command: "codex" } },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("TELEGRAM_ALLOWED_USER_IDS is required");
  });

  describe("handleCommand", () => {
    const config = {
      bots: {
        codex: { modelPreference: ["gpt-4o"], command: "c", token: "t" },
        antigravity: { modelPreference: ["antigravity-3.1-pro-preview"], command: "g", token: "t" },
      },
    } as any as BridgeConfig;

    let db: BridgeDb;

    beforeEach(() => { db = openDb(":memory:"); });
    afterEach(() => { db.close(); });

    it("handles /reset to clear session for the chat", () => {
      db.setSession("123", "antigravity", "session-123");
      const result = handleCommand("antigravity", "/reset", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("antigravity session reset");
      expect(db.getSession("123", "antigravity")).toBeNull();
    });

    it("only resets the session for the target chat, not others", () => {
      db.setSession("123", "antigravity", "s-123");
      db.setSession("456", "antigravity", "s-456");
      handleCommand("antigravity", "/reset", { db, chatId: "123", config });
      expect(db.getSession("456", "antigravity")).toBe("s-456");
    });

    it("handles /models returning keyboard_message with current model info", () => {
      const result = handleCommand("antigravity", "/models", { db, chatId: "123", config });
      expect(result?.kind).toBe("keyboard_message");
      expect(result && "text" in result ? result.text : "").toContain("antigravity-3.1-pro-preview");
      expect((result as any)?.reply_markup?.inline_keyboard).toBeDefined();
    });

    it("handles /start", () => {
      const result = handleCommand("antigravity", "/start", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("antigravity bridge ready");
    });

    it("turns a bounded /start payload into an ordinary execution prompt", () => {
      const result = handleCommand("antigravity", "/start investigate-health-systematic-debug-customer-app-http-non-2xx", {
        db,
        chatId: "123",
        config,
      });
      expect(result).toEqual({
        kind: "execute",
        prompt: expect.stringContaining("investigate-health-systematic-debug-customer-app-http-non-2xx"),
      });
    });

    it("keeps malformed or oversized /start payloads on the normal ready response", () => {
      for (const payload of ["not safe", "x".repeat(65), "payload_with_underscore"]) {
        const result = handleCommand("antigravity", `/start ${payload}`, { db, chatId: "123", config });
        expect(result?.kind).toBe("message");
      }
    });

    it("lists bundled skills with install guidance", () => {
      const result = handleCommand("codex", "/skills", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      const text = result && "text" in result ? result.text : "";
      expect(text).toContain("red-green-refactor-tdd");
      expect(text).toContain("npm run skills -- install");
    });

    it("builds a Codex usage command for /usage", () => {
      const result = handleCommand("codex", "/usage", { db, chatId: "123", config });
      expect(result?.kind).toBe("codex_usage");
    });

    it("keeps /usage Codex-only", () => {
      const result = handleCommand("claude", "/usage", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("only available on the Codex bridge");
    });

    it("enables and disables Antigravity narration visibility per chat", () => {
      const on = handleCommand("antigravity", "/narration on", { db, chatId: "123", config });
      expect(on?.kind).toBe("message");
      expect(on && "text" in on ? on.text : "").toContain("visible");
      expect(db.getSetting("antigravity:narration:123")).toBe("visible");

      const off = handleCommand("antigravity", "/narration off", { db, chatId: "123", config });
      expect(off?.kind).toBe("message");
      expect(off && "text" in off ? off.text : "").toContain("hidden");
      expect(db.getSetting("antigravity:narration:123")).toBe("hidden");
    });

    it("reports Antigravity narration status", () => {
      db.setSetting("antigravity:narration:123", "visible");
      const result = handleCommand("antigravity", "/narration status", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("visible");
    });

    it("keeps /narration Antigravity-only", () => {
      const result = handleCommand("codex", "/narration on", { db, chatId: "123", config });
      expect(result?.kind).toBe("message");
      expect(result && "text" in result ? result.text : "").toContain("only available on Antigravity");
      expect(db.getSetting("antigravity:narration:123")).toBeNull();
    });
  });
});




describe("model keyboard", () => {
  const prefs = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

  it("includes one button per model in the preference list", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      expect(allButtons.some((b: any) => b.text === model)).toBe(true);
    }
  });

  it("each model button carries the correct callback_data", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      const btn = allButtons.find((b: any) => b.text === model);
      expect(btn?.callback_data).toBe(`model:codex:${model}`);
    }
  });

  it("includes a Reset to Default button", () => {
    const kb = buildModelKeyboard("codex", prefs);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.callback_data === "model:codex:reset")).toBe(true);
  });

  it("returns an empty keyboard when preference list is empty", () => {
    const kb = buildModelKeyboard("codex", []);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.callback_data === "model:codex:reset")).toBe(true);
  });
});

describe("/models command returns keyboard_message", () => {
  const makeConfig = (prefs: string[]): BridgeConfig => ({
    allowedUserId: "1",
    serviceEnvFile: null,
    serviceKind: "codex",
    pollIntervalMs: 1000,
    executionMode: "safe",
    cliTimeoutMs: 300000,
    asyncEnabled: true,
    dbPath: ":memory:",
    bots: {
      codex: { token: "t", command: "codex", modelPreference: prefs },
      antigravity: { token: "t", command: "antigravity", modelPreference: [] },
    },
  });

  it("returns kind keyboard_message for /models", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    });
    expect(result?.kind).toBe("keyboard_message");
  });

  it("keyboard_message includes reply_markup with model buttons", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    }) as any;
    const allButtons = result.reply_markup.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(true);
    expect(allButtons.some((b: any) => b.text === "gpt-5.4")).toBe(true);
  });

  it("keyboard_message includes text describing current model", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => "gpt-5.4" } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    }) as any;
    expect(result.text).toContain("gpt-5.4");
  });
});

describe("/effort command returns keyboard_message", () => {
  const config = {
    allowedUserIds: new Set(["1"]),
    serviceEnvFile: null,
    serviceKind: "codex",
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: true,
    dbPath: ":memory:",
    bots: {
      codex: { token: "t", command: "codex", modelPreference: [] },
      antigravity: { token: "t", command: "agy", modelPreference: [] },
      claude: { token: "t", command: "claude", modelPreference: [] },
    },
  } as any;

  it("returns an effort keyboard with medium default", () => {
    const result = handleCommand("codex", "/effort", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config,
    }) as any;
    expect(result.kind).toBe("keyboard_message");
    expect(result.text).toContain("medium");
    expect(result.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "effort:codex:high")).toBe(true);
  });

  it("makes Agy unsupported status explicit", () => {
    const result = handleCommand("antigravity", "/effort", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config,
    }) as any;
    expect(result.text).toContain("unsupported");
  });
});

describe("/queue_mode command", () => {
  const config = {
    allowedUserIds: new Set(["1"]), serviceEnvFile: null, serviceKind: "codex", pollIntervalMs: 1000,
    executionMode: "safe", asyncEnabled: true, dbPath: ":memory:",
    bots: { codex: { token: "t", command: "codex", modelPreference: [] }, antigravity: { token: "t", command: "agy", modelPreference: [] }, claude: { token: "t", command: "claude", modelPreference: [] } },
  } as any;

  it("shows the lane's effective default and offers all modes plus reset", () => {
    const db = openDb(":memory:");
    const result = handleCommand("codex", "/queue_mode", {
      db, chatId: "100:7", config, surfaceIdentity: "telegram:interactive", defaultBusyMessageMode: "queue",
    }) as any;
    expect(result.kind).toBe("keyboard_message");
    expect(result.text).toContain("queue");
    expect(result.reply_markup.inline_keyboard.flat().map((button: any) => button.callback_data)).toEqual(expect.arrayContaining([
      "queue_mode:augment", "queue_mode:interrupt", "queue_mode:queue", "queue_mode:reset",
    ]));
    expect(db.getSetting(busyMessageModeSettingKey("telegram:interactive", "100:7"))).toBeNull();
    db.close();
  });
});

describe("Telegram command menu", () => {
  it("adds /queue_mode to every agent menu", () => {
    for (const kind of ["codex", "antigravity", "claude"] as const) {
      expect(buildTelegramCommands(kind)).toContainEqual({
        command: "queue_mode",
        description: "Set busy-message handling",
      });
    }
  });

  it("adds /effort to every agent menu", () => {
    for (const kind of ["codex", "antigravity", "claude"] as const) {
      expect(buildTelegramCommands(kind)).toContainEqual({
        command: "effort",
        description: "Switch reasoning effort",
      });
    }
  });

  it("adds /usage to the Codex menu only", () => {
    expect(buildTelegramCommands("codex")).toContainEqual({
      command: "usage",
      description: "Show Codex plan usage",
    });
    expect(buildTelegramCommands("antigravity").some((command: any) => command.command === "usage")).toBe(false);
    expect(buildTelegramCommands("claude").some((command: any) => command.command === "usage")).toBe(false);
  });

  it("adds /narration to the Antigravity menu only", () => {
    expect(buildTelegramCommands("antigravity")).toContainEqual({
      command: "narration",
      description: "Toggle Agy narration visibility",
    });
    expect(buildTelegramCommands("codex").some((command: any) => command.command === "narration")).toBe(false);
    expect(buildTelegramCommands("claude").some((command: any) => command.command === "narration")).toBe(false);
  });

  it("does not include /skills in the command palette", () => {
    for (const kind of ["codex", "antigravity", "claude"] as const) {
      expect(buildTelegramCommands(kind).some((c: any) => c.command === "skills")).toBe(false);
    }
  });

  it("does not include /memory in the command palette", () => {
    for (const kind of ["codex", "antigravity", "claude"] as const) {
      expect(buildTelegramCommands(kind).some((c: any) => c.command === "memory")).toBe(false);
    }
  });
});

describe("model keyboard current model indicator", () => {
  const prefs = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

  it("marks the active model button with a checkmark", () => {
    const kb = buildModelKeyboard("codex", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.4")).toBe(true);
  });

  it("does not mark non-active models with a checkmark", () => {
    const kb = buildModelKeyboard("codex", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.4-mini")).toBe(false);
  });

  it("active button still has correct callback_data", () => {
    const kb = buildModelKeyboard("codex", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    const btn = allButtons.find((b: any) => b.text === "✓ gpt-5.4");
    expect(btn?.callback_data).toBe("model:codex:gpt-5.4");
  });

  it("shows no checkmark when currentModel is null", () => {
    const kb = buildModelKeyboard("codex", prefs, null);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.every((b: any) => !b.text.startsWith("✓"))).toBe(true);
  });
});
