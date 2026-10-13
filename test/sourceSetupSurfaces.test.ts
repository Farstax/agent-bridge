import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { openProductionDb } from "../src/db.js";
import {
  bootstrapSourceSurfaceDb, normalizeSetupUserIds, parseSetupSurface,
  renderSurfaceSetupEnv, surfaceSourceDbPath,
  verifyDiscordBot, writePrivateSlackTokenFiles,
} from "../src/setupSurfaces.js";
import type { DetectedInteractiveProvider } from "../src/setup.js";

const provider: DetectedInteractiveProvider = {
  id: "codex", chainKind: "codex", displayName: "Codex",
  commandEnv: "CODEX_ACP_COMMAND", commandPath: "/opt/bin/codex-acp",
};

describe("standalone multi-surface source onboarding (#1003)", () => {
  it("selects only supported surfaces and defaults neither Slack nor Discord behind Telegram", () => {
    expect(["telegram", "discord", "slack"].map(parseSetupSurface)).toEqual(["telegram", "discord", "slack"]);
    expect(() => parseSetupSurface("farstax")).toThrow("Surface must be");
  });

  it("normalizes allowlists and rejects malformed/default-empty member identities", () => {
    expect(normalizeSetupUserIds("123456789012345678,123456789012345678", "discord")).toBe("123456789012345678");
    expect(normalizeSetupUserIds("U0123ABCD, W0123ABCD", "slack")).toBe("U0123ABCD,W0123ABCD");
    expect(() => normalizeSetupUserIds(" ", "slack")).toThrow("Invalid slack");
    expect(() => normalizeSetupUserIds("nick", "discord")).toThrow("Invalid discord");
  });

  it("renders isolated Discord configuration without reusing Telegram DB", () => {
    const raw = renderSurfaceSetupEnv({
      surface: "discord", projectDir: "/tmp/project", providers: [provider],
      userIds: "123456789012345678", discordBotToken: "secret", discordApplicationId: "987654321098765432",
    });
    const config = dotenv.parse(raw);
    expect(config.DISCORD_APPLICATION_ID).toBe("987654321098765432");
    expect(config.DISCORD_ALLOWED_USER_IDS).toBe("123456789012345678");
    expect(config.DB_PATH).toBe("/tmp/project/.data/discord-interactive.sqlite");
    expect(config.INTERACTIVE_CLI_CHAIN).toBe("codex");
    expect(config.TELEGRAM_BOT_TOKEN_INTERACTIVE).toBeUndefined();
  });

  it("Slack config stores secret-file paths, not token values", () => {
    const raw = renderSurfaceSetupEnv({
      surface: "slack", projectDir: "/tmp/project", providers: [provider],
      userIds: "U0123ABCD", slackBotTokenFile: "/private/bot", slackAppTokenFile: "/private/app",
    });
    const config = dotenv.parse(raw);
    expect(config.SLACK_BOT_TOKEN_FILE).toBe("/private/bot");
    expect(config.SLACK_APP_TOKEN_FILE).toBe("/private/app");
    expect(config.DB_PATH).toBe("/tmp/project/.data/slack-interactive.sqlite");
    expect(config.BRIDGE_EXECUTION_MODE).toBe("safe");
    expect(raw).not.toContain("xoxb-");
  });

  it("verifies Discord bot and matching application rather than trusting an ID field", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => (
        url.endsWith("/users/@me") ? { id: "123", bot: true } : { id: "987654321098765432" }
      ) };
    }) as typeof fetch;
    await expect(verifyDiscordBot("secret", "987654321098765432", fetcher)).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    await expect(verifyDiscordBot("secret", "000000000000000000", fetcher)).rejects.toThrow("does not match");
  });

  it("stages owner-only Slack secrets; rerun refuses to overwrite them", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-slack-secret-"));
    try {
      const files = { bot: join(dir, "private", "bot"), app: join(dir, "private", "app") };
      writePrivateSlackTokenFiles(files, "xoxb-test", "xapp-test");
      expect(statSync(files.bot).mode & 0o777).toBe(0o600);
      expect(statSync(files.app).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "private")).mode & 0o777).toBe(0o700);
      expect(() => writePrivateSlackTokenFiles(files, "xoxb-other", "xapp-other")).toThrow("already exist");
      expect(readFileSync(files.bot, "utf8")).toBe("xoxb-test\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["discord", "slack"] as const)("guarded bootstrap creates correct %s DB role and never rewrites existing state", (role) => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-surface-db-"));
    try {
      const dbPath = surfaceSourceDbPath(dir, role);
      expect(existsSync(dbPath)).toBe(false);
      bootstrapSourceSurfaceDb(dbPath, role);
      expect(existsSync(dbPath)).toBe(true);
      const db = openProductionDb(dbPath, { serviceId: role + ":interactive-test", databaseRole: role });
      db.raw.close();
      const before = statSync(dbPath).mtimeMs;
      bootstrapSourceSurfaceDb(dbPath, role);
      expect(statSync(dbPath).mtimeMs).toBe(before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
