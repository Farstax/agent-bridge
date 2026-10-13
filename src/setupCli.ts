#!/usr/bin/env tsx
import { existsSync, readFileSync, statSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { loadSlackConfig } from "./slackConfig.js";
import {
  bootstrapSourceSurfaceDb, normalizeSetupUserIds, parseSetupSurface,
  renderSurfaceSetupEnv, sourceSlackCredentialPaths,
  surfaceSourceDbPath, verifyDiscordBot, verifySlackSetup, writePrivateSlackTokenFiles,
  type SetupSurface,
} from "./setupSurfaces.js";
import { formatDoctorReport, runDoctor } from "./providers/doctor.js";
import {
  assertSupportedNodeVersion,
  bootstrapSourceInteractiveDb,
  detectInteractiveProviders,
  normalizeTelegramAllowedUserIds,
  renderInteractiveSetupEnv,
  validateProjectDirectory,
  validateTelegramBotToken,
  writeInteractiveSetupConfig,
} from "./setup.js";

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const force = args.has("--force");
const help = args.has("--help") || args.has("-h");
const surfaceIndex = rawArgs.indexOf("--surface");
const surfaceOption = surfaceIndex >= 0 ? rawArgs[surfaceIndex + 1] : rawArgs.find(a => a.startsWith("--surface="))?.slice(10);
if (surfaceIndex >= 0 && (!surfaceOption || surfaceOption.startsWith("--"))) throw new Error("--surface requires telegram, discord or slack");
const known = new Set(["--force", "--help", "-h", "--surface", ...(surfaceOption ? [surfaceOption, "--surface=" + surfaceOption] : [])]);
const unknownArgs = rawArgs.filter((a, i) => !known.has(a) || (a === surfaceOption && i !== surfaceIndex + 1 && surfaceIndex >= 0));


function printHelp(): void {
  console.log("Agent Bridge source setup\nUsage: npm run setup [-- --surface telegram|discord|slack] [--force]\n" +
    "Default noninteractive setup remains Telegram (TELEGRAM_BOT_TOKEN_INTERACTIVE, TELEGRAM_ALLOWED_USER_IDS, BRIDGE_PROJECT_DIR).\n" +
    "Discord: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_ALLOWED_USER_IDS.\n" +
    "Slack: SLACK_BOT_TOKEN_FILE and SLACK_APP_TOKEN_FILE (or env tokens), SLACK_ALLOWED_USER_IDS.\n" +
    "See docs/examples/discord-interactive.md and docs/slack.md for developer portal steps.");
}

async function askRequired(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  validate: (value: string) => string = (value) => {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("A value is required.");
    return trimmed;
  },
): Promise<string> {
  for (;;) {
    const value = await rl.question(prompt);
    try {
      return validate(value);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function main(): Promise<void> {
  if (unknownArgs.length) throw new Error("Unknown setup option(s): " + unknownArgs.join(", "));
  if (help) { printHelp(); return; }
  assertSupportedNodeVersion();
  const providers = detectInteractiveProviders();
  if (!providers.length) throw new Error("No supported authenticated coding-agent CLI was found on PATH.");
  console.log("Detected provider CLIs: " + providers.map(x => x.displayName).join(", "));
  const scripted = !process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const get = async (envName: string, label: string, validate?: (raw: string) => string): Promise<string> => {
    const existing = process.env[envName]?.trim();
    if (existing) return validate ? validate(existing) : existing;
    if (scripted) throw new Error("Noninteractive setup requires " + envName + ".");
    return askRequired(rl, label, validate);
  };
  try {
    const surface: SetupSurface = surfaceOption
      ? parseSetupSurface(surfaceOption)
      : scripted ? "telegram" : await askRequired(rl, "Select surface (telegram/discord/slack): ", parseSetupSurface);
    const file = surface === "telegram" ? ".env.interactive" : ".env." + surface + "-interactive";
    const configPath = resolve(process.cwd(), file);
    if (existsSync(configPath) && !force) throw new Error(configPath + " already exists. Re-run with --force to replace only this surface's config.");
    const projectDir = await get("BRIDGE_PROJECT_DIR", "Project/repository directory: ", validateProjectDirectory);
    let content: string;
    let dbPath: string;
    let command: string;
    if (surface === "telegram") {
      console.log("Telegram: create a bot with @BotFather, copy its token and your numeric Telegram user ID.");
      const telegramBotToken = await get("TELEGRAM_BOT_TOKEN_INTERACTIVE", "Telegram bot token: ");
      const telegramAllowedUserIds = await get("TELEGRAM_ALLOWED_USER_IDS", "Allowed Telegram user IDs (comma-separated): ", normalizeTelegramAllowedUserIds);
      const bot = await validateTelegramBotToken(telegramBotToken);
      console.log(bot.username ? "Validated Telegram bot @" + bot.username : "Validated Telegram bot token.");
      content = renderInteractiveSetupEnv({ telegramBotToken, telegramAllowedUserIds, projectDir, providers });
      dbPath = dotenv.parse(content).DB_PATH!;
      command = "npm start";
    } else if (surface === "discord") {
      console.log([
        "Discord Developer Portal: https://discord.com/developers/applications",
        "1. New Application, copy Application ID. Under Bot enable Message Content Intent.",
        "2. Copy bot token into a private local file (mode 0600).",
        "3. Developer Mode > Copy your numeric User ID; collect any allowed user IDs.",
        "4. Installation/OAuth2: bot + applications.commands scopes; invite to your test server.",
        "5. Optional Guild ID enables faster server-specific command registration.",
      ].join("\n"));
      const tokenFile = process.env.DISCORD_BOT_TOKEN_FILE?.trim() || (!process.env.DISCORD_BOT_TOKEN && !scripted ? await askRequired(rl, "Path to private Discord bot-token file: ") : "");
      if (tokenFile && (statSync(tokenFile).mode & 0o077)) throw new Error("Discord token file must have owner-only permissions (0600).");
      const token = process.env.DISCORD_BOT_TOKEN?.trim() || (tokenFile ? readFileSync(tokenFile, "utf8").trim() : "");
      if (!token) throw new Error("DISCORD_BOT_TOKEN or private DISCORD_BOT_TOKEN_FILE required.");
      const appId = await get("DISCORD_APPLICATION_ID", "Discord Application ID: ");
      const userIds = await get("DISCORD_ALLOWED_USER_IDS", "Allowed Discord numeric user IDs: ", raw => normalizeSetupUserIds(raw, "discord"));
      await verifyDiscordBot(token, appId);
      console.log("Discord bot token and application ID verified.");
      content = renderSurfaceSetupEnv({
        surface, projectDir, userIds, providers, discordBotToken: token,
        discordApplicationId: appId, discordGuildId: process.env.DISCORD_GUILD_ID,
      });
      dbPath = surfaceSourceDbPath(projectDir, "discord");
      command = "npx tsx src/index-discord-interactive.ts";
    } else {
      console.log([
        "Slack setup: https://api.slack.com/apps",
        "1. Create New App > From an app manifest > select intended workspace > YAML.",
        "2. Paste examples/slack-app-manifest.yaml, review and Create.",
        "3. The manifest enables Socket Mode, App Home messages, app_mention and message.im.",
        "4. Bot scopes: app_mentions:read, im:history, chat:write, users:read.",
        "5. OAuth & Permissions > Install to Workspace > Allow (or obtain admin approval).",
        "6. Copy Bot User OAuth Token (xoxb-...) into a private mode-0600 file.",
        "7. Basic Information > App-Level Tokens > Generate with connections:write.",
        "8. Copy nonrotating app-level token (xapp-...) to a separate private file.",
        "9. In Slack profile choose Copy member ID (U.../W...), not email/display name.",
        "10. Never share one Slack app across two active Socket Mode consumers.",
        "11. Slack v1 supports allowlisted DMs and explicit channel mentions; replies stay threaded.",
        "12. Commands are !cli, !stop, !cancel and !reset (not slash commands).",
      ].join("\n"));
      const userIds = await get("SLACK_ALLOWED_USER_IDS", "Allowed Slack member IDs (comma-separated): ", raw => normalizeSetupUserIds(raw, "slack"));
      let botFile = process.env.SLACK_BOT_TOKEN_FILE?.trim();
      let appFile = process.env.SLACK_APP_TOKEN_FILE?.trim();
      const rawBot = process.env.SLACK_BOT_TOKEN?.trim();
      const rawApp = process.env.SLACK_APP_TOKEN?.trim();
      let createFiles = false;
      if (rawBot && rawApp && !botFile && !appFile) {
        const paths = sourceSlackCredentialPaths(process.cwd());
        botFile = paths.bot; appFile = paths.app; createFiles = true;
      } else {
        if (rawBot || rawApp) throw new Error("Supply either both Slack token files or both raw env tokens.");
        botFile ||= await get("SLACK_BOT_TOKEN_FILE", "Private xoxb bot-token file: ");
        appFile ||= await get("SLACK_APP_TOKEN_FILE", "Private xapp app-token file: ");
      }
      if (createFiles && existsSync(botFile!) && existsSync(appFile!)) {
        if (readFileSync(botFile!, "utf8").trim() !== rawBot || readFileSync(appFile!, "utf8").trim() !== rawApp) {
          throw new Error("Slack token files already exist with different contents. Stop the service and rotate the files manually.");
        }
        createFiles = false;
      }
      if (!createFiles) {
        for (const filePath of [botFile!, appFile!]) {
          const info = lstatSync(filePath);
          if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) {
            throw new Error("Slack token files must be private regular files (mode 0600).");
          }
        }
      }
      const loaded = createFiles
        ? { botToken: rawBot!, appToken: rawApp! }
        : loadSlackConfig({ SLACK_BOT_TOKEN_FILE: botFile, SLACK_APP_TOKEN_FILE: appFile, SLACK_ALLOWED_USER_IDS: userIds });
      const appId = await verifySlackSetup(loaded.botToken, loaded.appToken, userIds.split(","));
      console.log("Slack bot app " + appId + " verified. App-level token will be bound by the actual Socket Mode hello on first runtime connection.");
      content = renderSurfaceSetupEnv({ surface, projectDir, userIds, providers, slackBotTokenFile: botFile, slackAppTokenFile: appFile });
      dbPath = surfaceSourceDbPath(projectDir, "slack");
      command = "npx tsx src/index-slack-interactive.ts";
      if (createFiles) {
        writePrivateSlackTokenFiles({ bot: botFile, app: appFile }, loaded.botToken, loaded.appToken);
        console.log("Created private Slack token files, owner-only. No tokens written to environment config.");
      }
    }
    const generated = dotenv.parse(content);
    const report = runDoctor({ env: generated, requiredEnv: [
      "BRIDGE_PROJECT_DIR", "DB_PATH",
      ...(surface === "telegram" ? ["TELEGRAM_BOT_TOKEN_INTERACTIVE", "TELEGRAM_ALLOWED_USER_IDS"] :
      surface === "discord" ? ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_ALLOWED_USER_IDS"] :
      ["SLACK_BOT_TOKEN_FILE", "SLACK_APP_TOKEN_FILE", "SLACK_ALLOWED_USER_IDS"]),
    ] });
    console.log("\n" + formatDoctorReport(report));
    if (!report.ok) throw new Error("Provider Doctor failed; fix the reported item before starting Agent Bridge.");
    if (surface === "telegram") bootstrapSourceInteractiveDb(dbPath);
    else bootstrapSourceSurfaceDb(dbPath, surface);
    writeInteractiveSetupConfig(configPath, content, { force });
    console.log("Setup complete. Config: " + configPath + "; database: " + dbPath);
    console.log("Start: " + command);
    console.log(surface === "slack"
      ? "Confirm fresh Socket Mode connected readiness; DM the app as the allowed user, then mention it in an invited channel to test threaded reply."
      : "Send an authorized first message after the companion connects.");
    console.log("To add another surface rerun npm run setup -- --surface <telegram|discord|slack>.");
  } finally { rl.close(); }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
