#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import dotenv from "dotenv";
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

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const help = args.has("--help") || args.has("-h");
const unknownArgs = [...args].filter((arg) => !["--force", "--help", "-h"].includes(arg));

function printHelp(): void {
  console.log(`Agent Bridge source setup\n\nUsage:\n  npm run setup\n  npm run setup -- --force\n  npm run setup -- --help\n\nEnvironment inputs for non-interactive use:\n  TELEGRAM_BOT_TOKEN_INTERACTIVE\n  TELEGRAM_ALLOWED_USER_IDS\n  BRIDGE_PROJECT_DIR\n\nThe wizard requires Node.js 24+, at least one authenticated provider CLI on PATH, and network access to validate the Telegram bot token.`);
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
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown setup option(s): ${unknownArgs.join(", ")}`);
  }
  if (help) {
    printHelp();
    return;
  }

  assertSupportedNodeVersion();

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

  const nonInteractive = !process.stdin.isTTY;
  const missingNonInteractiveInputs = [
    ["TELEGRAM_BOT_TOKEN_INTERACTIVE", process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE],
    ["TELEGRAM_ALLOWED_USER_IDS", process.env.TELEGRAM_ALLOWED_USER_IDS],
    ["BRIDGE_PROJECT_DIR", process.env.BRIDGE_PROJECT_DIR],
  ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (nonInteractive && missingNonInteractiveInputs.length > 0) {
    throw new Error(
      `Non-interactive setup requires environment values for: ${missingNonInteractiveInputs.join(", ")}. Run npm run setup -- --help for details.`,
    );
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

    const botIdentity = await validateTelegramBotToken(telegramBotToken);
    console.log(
      botIdentity.username
        ? `Validated Telegram bot @${botIdentity.username}.`
        : "Validated Telegram bot token.",
    );

    const content = renderInteractiveSetupEnv({
      telegramBotToken,
      telegramAllowedUserIds,
      projectDir,
      providers,
    });
    writeInteractiveSetupConfig(configPath, content, { force });
    console.log(`\nWrote ${configPath} with mode 0600.`);

    const generatedEnv = dotenv.parse(content);
    const report = runDoctor({
      env: generatedEnv,
      requiredEnv: ["TELEGRAM_BOT_TOKEN_INTERACTIVE", "TELEGRAM_ALLOWED_USER_IDS", "BRIDGE_PROJECT_DIR", "DB_PATH"],
    });
    console.log("\n" + formatDoctorReport(report));
    if (!report.ok) {
      throw new Error("Setup wrote the configuration, but Doctor found a problem. Fix the reported item before starting Agent Bridge.");
    }

    const dbPath = generatedEnv.DB_PATH;
    if (!dbPath) throw new Error("Setup did not generate DB_PATH.");
    bootstrapSourceInteractiveDb(dbPath);
    console.log(`Initialized source interactive database: ${dbPath}`);

    console.log("\nSetup complete. Start Agent Bridge with: npm start");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});