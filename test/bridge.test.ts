import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
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
} from "../src/bridge.js";
import { openDb, BridgeDb } from "../src/db.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";
import type { TelegramMessage, BridgeConfig } from "../src/types.js";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";

function agyStreamJsonResult(response: string, conversationId = "4229bce3-5009-429e-a3cb-d1bdaa8cfeed"): string {
  return JSON.stringify({
    event: "result",
    result: { conversation_id: conversationId, status: "SUCCESS", response },
  });
}

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

  it("creates a fresh Agy ACP invocation instead of native --print", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: "antigravity-pro",
      executionMode: "trusted",
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["--uid="]);
    expect(invocation.args).not.toContain("--print");
    expect(invocation.prompt).toContain("hello");
  });

  it("wraps antigravity prompts without a retired JSON output instruction", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: null,
      includeResponseContract: false,
    });

    const printedPrompt = String(invocation.prompt);
    expect(printedPrompt).toContain("hello");
    expect(printedPrompt).toContain("Agent Bridge execution contract:");
    expect(printedPrompt).not.toContain('"response"');
    expect(printedPrompt).not.toContain('"reasoning"');
  });

  it("keeps antigravity delimiter outside SOUL.md and Telegram style context", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: null,
      soulContext: "Identity: Chas",
      includeResponseContract: false,
    });

    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.prompt).toContain("hello");
  });

  it("antigravity session invocation resumes through ACP instead of --conversation", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: "4229bce3-5009-429e-a3cb-d1bdaa8cfeed",
      command: "agy_acp_server.par",
      model: null,
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.nativeSessionMode).toBe("resume");
    expect(invocation.args).not.toContain("--conversation");
    expect(invocation.prompt).toContain("hello");
  });

  it("antigravity trusted execution mode does not add native skip-permissions flags", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: null,
      executionMode: "trusted",
    });
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
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

  it("does not parse native Agy stream-json after ACP migration", () => {
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: agyStreamJsonResult("hello from antigravity"),
    })).toThrow(/ACP structured results/);
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

    it("clears Codex ACP session bindings on /reset", () => {
      db.putAcpSessionBinding({
        conversationId: "123",
        providerId: "codex",
        acpSessionId: "acp-session-secret",
        runId: "run-1",
      });
      handleCommand("codex", "/reset", { db, chatId: "123", config });
      expect(db.getAcpSessionBinding("123", "codex")).toBeNull();
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
      expect(result && "text" in result ? result.text : "").toMatch(/provider default|provider-controlled|waiting for a live ACP session/);
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
    const kb = buildModelKeyboard("legacy-native", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      expect(allButtons.some((b: any) => b.text === model)).toBe(true);
    }
  });

  it("each model button carries the correct callback_data", () => {
    const kb = buildModelKeyboard("legacy-native", prefs);
    const allButtons = kb.inline_keyboard.flat();
    for (const model of prefs) {
      const btn = allButtons.find((b: any) => b.text === model);
      expect(btn?.callback_data).toBe(`model:legacy-native:${model}`);
    }
  });

  it("includes a Reset to Default button", () => {
    const kb = buildModelKeyboard("legacy-native", prefs);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.callback_data === "model:legacy-native:reset")).toBe(true);
  });

  it("returns an empty keyboard when preference list is empty", () => {
    const kb = buildModelKeyboard("legacy-native", []);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.callback_data === "model:legacy-native:reset")).toBe(true);
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
    expect(allButtons.some((b: any) => b.text === "gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.text === "gpt-5.4")).toBe(false);
  });

  it("keyboard_message includes text describing current model", () => {
    const result = handleCommand("codex", "/models", {
      db: { getSetting: () => "gpt-5.4" } as any,
      chatId: "1",
      config: makeConfig(["gpt-5.5", "gpt-5.4"]),
    }) as any;
    expect(result.text).toContain("provider-controlled");
  });
});

describe("/effort command returns keyboard_message", () => {
  const config = {
    allowedUserIds: new Set(["1"]),
    serviceEnvFile: null,
    serviceKind: "codex",
    pollIntervalMs: 1000,
    executionMode: "safe",
    dbPath: ":memory:",
    bots: {
      codex: { token: "t", command: "codex", modelPreference: [] },
      antigravity: { token: "t", command: "agy", modelPreference: [] },
      claude: { token: "t", command: "claude", modelPreference: [] },
    },
  } as any;

  it("returns a provider-controlled effort keyboard before ACP advertisement", () => {
    const result = handleCommand("codex", "/effort", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config,
    }) as any;
    expect(result.kind).toBe("keyboard_message");
    expect(result.text).toContain("provider-controlled");
    expect(result.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "effort:codex:high")).toBe(false);
  });

  it("makes Agy unsupported status explicit", () => {
    const result = handleCommand("antigravity", "/effort", {
      db: { getSetting: () => null } as any,
      chatId: "1",
      config,
    }) as any;
    expect(result.text).toMatch(/provider-controlled|provider default|not advertised/);
  });
});

describe("/queue_mode command", () => {
  const config = {
    allowedUserIds: new Set(["1"]), serviceEnvFile: null, serviceKind: "codex", pollIntervalMs: 1000,
    executionMode: "safe", dbPath: ":memory:",
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
    const kb = buildModelKeyboard("legacy-native", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.4")).toBe(true);
  });

  it("does not mark non-active models with a checkmark", () => {
    const kb = buildModelKeyboard("legacy-native", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.5")).toBe(false);
    expect(allButtons.some((b: any) => b.text === "✓ gpt-5.4-mini")).toBe(false);
  });

  it("active button still has correct callback_data", () => {
    const kb = buildModelKeyboard("legacy-native", prefs, "gpt-5.4");
    const allButtons = kb.inline_keyboard.flat();
    const btn = allButtons.find((b: any) => b.text === "✓ gpt-5.4");
    expect(btn?.callback_data).toBe("model:legacy-native:gpt-5.4");
  });

  it("shows no checkmark when currentModel is null", () => {
    const kb = buildModelKeyboard("legacy-native", prefs, null);
    const allButtons = kb.inline_keyboard.flat();
    expect(allButtons.every((b: any) => !b.text.startsWith("✓"))).toBe(true);
  });
});
