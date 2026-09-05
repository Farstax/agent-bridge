import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { openProductionDb } from "../src/db.js";
import {
  bootstrapSourceInteractiveDb,
  detectInteractiveProviders,
  normalizeTelegramAllowedUserIds,
  renderInteractiveSetupEnv,
  resolveSourceInteractiveDbPath,
  validateProjectDirectory,
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
      dbPath: "/srv/agent-bridge/.data/bridge.sqlite",
      providers,
    });
    const parsed = dotenv.parse(content);

    expect(parsed.TELEGRAM_BOT_TOKEN_INTERACTIVE).toBe("123456:secret-token");
    expect(parsed.TELEGRAM_ALLOWED_USER_IDS).toBe("123,456");
    expect(parsed.BRIDGE_PROJECT_DIR).toBe("/srv/example-app");
    expect(parsed.DB_PATH).toBe("/srv/agent-bridge/.data/bridge.sqlite");
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

  it("bootstraps a missing source DB that the strict runtime opener accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-setup-db-"));
    const dbPath = join(dir, ".data", "bridge.sqlite");
    try {
      expect(resolveSourceInteractiveDbPath({ DB_PATH: dbPath }, dir)).toBe(dbPath);
      const result = bootstrapSourceInteractiveDb({ DB_PATH: dbPath }, dir);
      expect(result).toEqual({ dbPath, created: true });
      expect(existsSync(dbPath)).toBe(true);

      const strict = openProductionDb(dbPath, {
        serviceId: "telegram:interactive",
        databaseRole: "interactive",
      });
      strict.raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never replaces an existing source DB during setup", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-setup-existing-db-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      writeFileSync(dbPath, "existing-state", "utf8");
      const result = bootstrapSourceInteractiveDb({ DB_PATH: dbPath }, dir);
      expect(result).toEqual({ dbPath, created: false });
      expect(readFileSync(dbPath, "utf8")).toBe("existing-state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
