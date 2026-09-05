#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
import { formatDoctorReport, runDoctor } from "./providers/doctor.js";
import {
  bootstrapSourceInteractiveDb,
  detectInteractiveProviders,
  normalizeTelegramAllowedUserIds,
  renderInteractiveSetupEnv,
  validateProjectDirectory,
  writeInteractiveSetupConfig,
} from "./setup.js";

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const help = args.has("--help") || args.has("-h");
const unknownArgs = [...args].filter((arg) => arg !== "--force" && arg !== "--help" && arg !== "-h");

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

function printHelp(): void {
  console.log(`Agent Bridge source setup

Usage:
  npm run setup
  npm run setup -- --force

Options:
  --force   replace an existing .env.interactive
  -h, --help  show this help

For non-interactive setup, provide TELEGRAM_BOT_TOKEN_INTERACTIVE,
TELEGRAM_ALLOWED_USER_IDS, and BRIDGE_PROJECT_DIR in the environment.
At least one supported provider CLI must be installed and authenticated on PATH.`);
}

async function main(): Promise<void> {
  if (help) {
    printHelp();
    return;
  }
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown setup option(s): ${unknownArgs.join(", ")}`);
  }

  const configPath = resolve(process.cwd(), ".env.interactive");
  if (existsSync(configPath) && !force) {
    throw new Error(`${configPath} already exists. Re-run with --force to replace it.`);
  }

  const providers = detectInteractiveProviders();
  if (providers.length === 0) {
    throw new Error(
      "No supported coding-agent CLI was found on PATH. Install and authenticate at least one of: codex, claude, agy, grok, cursor-agent.",
    );
  }

  console.log("Detected provider CLIs:");
  for (const provider of providers) {
    console.log(`- ${provider.displayName}: ${provider.commandPath}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE?.trim()
      || await askRequired(rl, "Telegram bot token: ");
    const telegramAllowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()
      || await askRequired(rl, "Allowed Telegram user IDs (comma-separated): ", normalizeTelegramAllowedUserIds);
    const configuredProjectDir = process.env.BRIDGE_PROJECT_DIR?.trim();
    const projectDir = configuredProjectDir
      ? validateProjectDirectory(configuredProjectDir)
      : await askRequired(rl, "Project/repository directory: ", validateProjectDirectory);
    const dbPath = resolve(process.env.DB_PATH?.trim() || resolve(process.cwd(), ".data", "bridge.sqlite"));

    const content = renderInteractiveSetupEnv({
      telegramBotToken,
      telegramAllowedUserIds,
      projectDir,
      providers,
      dbPath,
    });
    writeInteractiveSetupConfig(configPath, content, { force });
    console.log(`\nWrote ${configPath} with mode 0600.`);

    const generatedEnv = dotenv.parse(content);
    const bootstrap = bootstrapSourceInteractiveDb(generatedEnv);
    if (bootstrap.created) {
      console.log(`Created source runtime database: ${bootstrap.dbPath}`);
    } else {
      console.log(`Using existing source runtime database: ${bootstrap.dbPath}`);
    }

    const report = runDoctor({
      env: generatedEnv,
      requiredEnv: ["TELEGRAM_BOT_TOKEN_INTERACTIVE", "TELEGRAM_ALLOWED_USER_IDS", "BRIDGE_PROJECT_DIR"],
    });
    console.log("\n" + formatDoctorReport(report));
    if (!report.ok) {
      throw new Error("Setup wrote the configuration, but Doctor found a problem. Fix the reported item before starting Agent Bridge.");
    }

    console.log("\nSetup complete. Start Agent Bridge with: npm start");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
