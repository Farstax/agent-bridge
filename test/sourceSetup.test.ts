import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { openProductionDb } from "../src/db.js";
import {
  assertSupportedNodeVersion,
  bootstrapSourceInteractiveDb,
  detectInteractiveProviders,
  normalizeTelegramAllowedUserIds,
  renderInteractiveSetupEnv,
  resolveSourceInteractiveDbPath,
  validateProjectDirectory,
  validateTelegramBotToken,
  writeInteractiveSetupConfig,
} from "../src/setup.js";

describe("source setup", () => {
  it("detects interactive providers through the shared registry and keeps runtime fallback order", () => {
    const installed = new Map([
      ["codex", "/usr/local/bin/codex"],
      ["grok", "/usr/local/bin/grok"],
      ["agy", "/usr/local/bin/agy"],
      ["cursor-agent", "/usr/local/bin/cursor-agent"],
    ]);

    const providers = detectInteractiveProviders({
      env: {},
      resolvePath: (command) => installed.get(command) ?? null,
    });

    expect(providers.map((provider) => provider.chainKind)).toEqual([
      "codex",
      "grok",
      "antigravity",
      "cursor",
    ]);
    expect(providers.map((provider) => provider.commandEnv)).toEqual([
      "CODEX_COMMAND",
      "GROK_COMMAND",
      "ANTIGRAVITY_COMMAND",
      "CURSOR_COMMAND",
    ]);
  });

  it("renders one minimal interactive config from detected providers", () => {
    const providers = detectInteractiveProviders({
      env: {},
      resolvePath: (command) => ({
        codex: "/opt/bin/codex",
        claude: "/opt/bin/claude",
      } as Record<string, string | undefined>)[command] ?? null,
    });

    const content = renderInteractiveSetupEnv({
      telegramBotToken: "123456:secret-token",
      telegramAllowedUserIds: "123, 456,123",
      projectDir: "/srv/example-app",
      providers,
    });
    const parsed = dotenv.parse(content);

    expect(parsed.TELEGRAM_BOT_TOKEN_INTERACTIVE).toBe("123456:secret-token");
    expect(parsed.TELEGRAM_ALLOWED_USER_IDS).toBe("123,456");
    expect(parsed.BRIDGE_PROJECT_DIR).toBe("/srv/example-app");
    expect(parsed.DB_PATH).toBe(resolveSourceInteractiveDbPath("/srv/example-app"));
    expect(parsed.CODEX_COMMAND).toBe("/opt/bin/codex");
    expect(parsed.CLAUDE_COMMAND).toBe("/opt/bin/claude");
    expect(parsed.INTERACTIVE_DEFAULT_CLI).toBe("codex");
    expect(parsed.INTERACTIVE_CLI_CHAIN).toBe("codex,claude");
    expect(parsed.BRIDGE_BUSY_MESSAGE_MODE).toBe("interrupt");
    expect(parsed.BRIDGE_EXECUTION_MODE).toBeUndefined();
  });

  it("normalizes Telegram user IDs without coercing them to JavaScript numbers", () => {
    expect(normalizeTelegramAllowedUserIds("9007199254740993, 7")).toBe("9007199254740993,7");
    expect(() => normalizeTelegramAllowedUserIds("7,not-an-id")).toThrow("Invalid Telegram user ID");
    expect(() => normalizeTelegramAllowedUserIds(" , ")).toThrow("At least one Telegram user ID is required");
  });

  it("requires an existing project directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-setup-project-"));
    try {
      expect(validateProjectDirectory(dir)).toBe(dir);
      expect(() => validateProjectDirectory(join(dir, "missing"))).toThrow("Project directory does not exist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires Node.js 24 or newer for source setup", () => {
    expect(() => assertSupportedNodeVersion("24.0.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("25.1.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("20.19.0")).toThrow("requires Node.js 24+");
  });

  it("validates the Telegram bot token before setup declares success", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { id: 42, username: "bridge_test_bot", first_name: "Bridge" } }),
      };
    }) as typeof fetch;

    await expect(validateTelegramBotToken("123456:secret-token", fakeFetch)).resolves.toEqual({
      id: 42,
      username: "bridge_test_bot",
      firstName: "Bridge",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/getMe");
  });

  it("rejects a Telegram token that Telegram reports as unauthorized", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: "Unauthorized" }),
    })) as typeof fetch;

    await expect(validateTelegramBotToken("bad-token", fakeFetch)).rejects.toMatchObject({ status: 401 });
  });

  it("bootstraps the exact source database that strict startup can reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-source-db-"));
    const dbPath = join(dir, ".data", "bridge.sqlite");
    try {
      expect(existsSync(dbPath)).toBe(false);
      bootstrapSourceInteractiveDb(dbPath);
      expect(existsSync(dbPath)).toBe(true);

      const db = openProductionDb(dbPath, {
        serviceId: "telegram:interactive",
        databaseRole: "interactive",
      });
      db.raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes setup secrets with mode 0600 and refuses replacement without force", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-setup-config-"));
    const configPath = join(dir, ".env.interactive");
    try {
      writeInteractiveSetupConfig(configPath, "first\n");
      expect(readFileSync(configPath, "utf8")).toBe("first\n");
      expect(statSync(configPath).mode & 0o777).toBe(0o600);

      expect(() => writeInteractiveSetupConfig(configPath, "second\n")).toThrow("already exists");
      expect(readFileSync(configPath, "utf8")).toBe("first\n");

      writeInteractiveSetupConfig(configPath, "second\n", { force: true });
      expect(readFileSync(configPath, "utf8")).toBe("second\n");
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
