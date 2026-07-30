/**
 * PURPOSE: Entry point for the dedicated health monitoring bot service.
 * Runs independently from the main bridge bots — uses its own Telegram bot token,
 * its own SQLite DB, and has no shared state with agent-bridge-claude/codex/antigravity services.
 * Uses BridgeEngine for robust polling, locking, queuing, and /stop abort handling.
 */

import dotenv from "dotenv";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { TelegramClient } from "./telegram.js";
import { HealthScheduler } from "./health/scheduler.js";
import { HealthBridgeBot } from "./health/bot.js";
import { SelfPlugin } from "./health/plugins/self.js";
import { ExternalPlugin } from "./health/plugins/external.js";
import { ServerPlugin } from "./health/plugins/server.js";
import { parseHealthEnabled, parseCadenceSeconds, parseHealthCliConfig } from "./health/config.js";
import { formatReport } from "./health/reporter.js";
import { openProductionDb } from "./db.js";
import { BridgeEngine } from "./engine.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { shutdownCliProcesses } from "./cliSupervisor.js";
import { getExecutionProcessState } from "./cliSupervisor.js";
import { autoUpdateClis } from "./health/autoRemediate.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import type { BotKind } from "./types.js";
import type { HealthPlugin } from "./health/types.js";

// ── Config ──────────────────────────────────────────────────────────────────
dotenv.config({ path: process.env.BRIDGE_ENV_FILE || ".env", override: false });


const token = process.env.TELEGRAM_BOT_TOKEN_HEALTH;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN_HEALTH is required for the health bot service");
}

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);
if (!allowedUserIds.size) {
  throw new Error("TELEGRAM_ALLOWED_USER_IDS is required");
}

const chatId = process.env.HEALTH_MONITOR_CHAT_ID
  ? Number(process.env.HEALTH_MONITOR_CHAT_ID)
  : null;

const healthEnabled = parseHealthEnabled(process.env);
const cadenceSeconds = parseCadenceSeconds(process.env);
const autonomy = (process.env.HEALTH_MONITOR_AUTONOMY as "report" | "suggest") || "report";
const sessionTtlSeconds = Number(process.env.HEALTH_SESSION_TTL_SECONDS) > 0
  ? Number(process.env.HEALTH_SESSION_TTL_SECONDS)
  : 1800;

function parseHealthCliBot(value: string | undefined): BotKind {
  if (value === "codex" || value === "antigravity" || value === "claude") return value;
  return "claude";
}

function defaultHealthCliCommand(bot: BotKind): string {
  if (bot === "codex") return process.env.CODEX_COMMAND || "codex";
  if (bot === "antigravity") return process.env.ANTIGRAVITY_COMMAND || "agy";
  return process.env.CLAUDE_COMMAND || "claude";
}

const _healthCliParsed = parseHealthCliConfig(process.env);
const cliBot = _healthCliParsed.bot;
const cliBotConfig = {
  command: _healthCliParsed.command ?? defaultHealthCliCommand(cliBot),
  modelPreference: _healthCliParsed.modelPreference,
};

const dbPath = process.env.HEALTH_DB_PATH || "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";

// ── Infrastructure ───────────────────────────────────────────────────────────
const bridgeDb = openProductionDb(dbPath, {
  serviceId: "telegram:health",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "health",
});
await bridgeDb.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 60_000),
  processState: (run) => getExecutionProcessState(run.run_id),
  containmentState: (_run, state) => state === "absent" ? "proven" : "ambiguous",
  onReconciled: (run) => console.warn(`[health-bot] reconciled orphaned run ${run.run_id}`),
});
const rawDb = bridgeDb.raw;
const client = new TelegramClient(token, fetch, resolveTimeoutsForKind(cliBot).fetchTimeoutMs);

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(process.env.BRIDGE_PROJECT_DIR || process.cwd()),
});
if (soulContext) console.log(`[health-bot] loaded SOUL.md context (${soulContext.length} chars)`);

const sendText = async (text: string): Promise<void> => {
  if (!chatId) {
    console.log(`[health-bot] no HEALTH_MONITOR_CHAT_ID, dropping message:\n${text}`);
    return;
  }
  await sendTelegramMessage({ client, kind: cliBot, chatId, body: { text } });
};

// ── Health bot ───────────────────────────────────────────────────────────────
const healthBot = new HealthBridgeBot({
  db: rawDb,
  chatId: chatId ?? 0,
  sessionTtlSeconds,
  autonomy,
  cliBot,
  cliBotConfig,
  _sendText: sendText,
});

// ── Health plugins ───────────────────────────────────────────────────────────
const plugins: HealthPlugin[] = [new SelfPlugin(bridgeDb, dbPath)];

if (process.env.HEALTH_SERVER_MONITOR_ENABLED !== "0") {
  plugins.push(new ServerPlugin());
  if (healthEnabled) console.log("[health-bot] server plugin enabled");
}

if (process.env.HEALTH_CONTENT_CRAWLER_ENABLED === "1") {
  const script = process.env.HEALTH_CONTENT_CRAWLER_SCRIPT
    || `${process.env.HOME}/content-crawler/scripts/health_check.py`;
  const python = `${process.env.HOME}/content-crawler/venv/bin/python3`;
  plugins.push(new ExternalPlugin({ name: "content-crawler", command: python, args: [script], timeoutMs: 30_000 }));
  if (healthEnabled) console.log(`[health-bot] content-crawler plugin enabled: ${script}`);
}

// ── Scheduler ────────────────────────────────────────────────────────────────
const scheduler = new HealthScheduler({
  plugins,
  config: {
    enabled: healthEnabled,
    cadenceSeconds,
    autonomy: "report",
  },
  sendReport: async (text) => {
    if (!chatId) {
      console.log(`[health-bot] report (no chatId):\n${text}`);
    }
  },
  onRawReport: async (report) => {
    await healthBot.handleReport(report);
    const _repoRoot = process.env.BRIDGE_PROJECT_DIR
      ?? new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    await autoUpdateClis(report, {
      upgradeScript: `${_repoRoot}/scripts/upgrade.sh`,
      sendNotification: sendText,
    });
  },
});

// ── BridgeEngine with health hooks ───────────────────────────────────────────
const engine = new BridgeEngine(
  {
    kind: "health",
    surfaceIdentity: "telegram:health",
    executionKind: cliBot,
    botConfig: { command: cliBotConfig.command, modelPreference: cliBotConfig.modelPreference },
    allowedUserIds,
    executionMode: "safe",
    asyncEnabled: false,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
    soulContext,
    hooks: {
      onCommand: async (cmd, ctx) => {
        if (cmd === "/health") {
          await engine.sendText(ctx.chatId, { text: "Checking health..." });
          const results = await Promise.all(plugins.map(p => p.check()));
          const combined = results.map(r => formatReport(r)).join("\n\n---\n\n");
          // Persist reports through healthBot for context store without sending duplicates.
          await Promise.all(results.map(r => healthBot.handleReport(r, { force: true, silent: true })));
          return { text: combined || "✅ All checks passed." };
        }

        if (cmd === "/status") {
          const { HealthContextStore } = await import("./health/context.js");
          const store = new HealthContextStore(rawDb);
          const context = store.getContext();
          if (!context?.lastReport) {
            return { text: "No health data yet. Use /health to run a check." };
          }
          let statusText = formatReport(context.lastReport);
          if (context.lastSuggestion) {
            statusText += `\n\n*Last suggestion:*\n\n${context.lastSuggestion}`;
          }
          return { text: statusText };
        }

        return null;
      },

      onBeforeExecute: async (prompt) => {
        return healthBot.buildOnDemandPrompt(prompt);
      },
    },
  },
  bridgeDb,
  client,
);

// ── Start ────────────────────────────────────────────────────────────────────
console.log("[health-bot] starting...");

await client.setMyCommands({
  commands: [
    { command: "health", description: "Run health checks immediately" },
    { command: "status", description: "Show last health report and suggestions" },
    { command: "models", description: "Switch model for CLI suggestions" },
    { command: "reset", description: "Clear current session" },
    { command: "stop", description: "Abort running execution" },
  ],
}).catch((err) => console.warn(`[health-bot] setMyCommands failed`, err));

if (healthEnabled) {
  scheduler.start();
  for (const plugin of plugins) {
    plugin.check().then(report => healthBot.handleReport(report)).catch((err: unknown) =>
      console.error("[health-bot] startup check error", err)
    );
  }
  console.log(`[health-bot] scheduler started — cadence ${cadenceSeconds}s, autonomy=${autonomy}`);
}

const shutdown = (signal: string) => {
  console.log(`[health-bot] ${signal} received, shutting down...`);
  scheduler.stop();
  shutdownCliProcesses();
  rawDb.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await engine.run();
