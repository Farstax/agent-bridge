/**
 * PURPOSE: Entry point for agent bridge bots (Claude, Codex, Antigravity).
 * Bootstraps config, database, and per-bot BridgeEngine instances.
 * NEIGHBORS: src/engine.ts, src/bridge.ts, src/cli.ts, src/db.ts
 */

import dotenv from "dotenv";
import { basename } from "node:path";
import { getBridgeProjectDir } from "./bridge.js";
import { validateBridgeConfig } from "./config.js";
import { openProductionDb } from "./db.js";
import { getExecutionProcessState, shutdownCliProcesses } from "./cliSupervisor.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import type { BridgeConfig, BotConfig, BotKind } from "./types.js";
import { loadBotsConfig, validateTokenUniqueness, resolveExecutionMode, resolveBusyMessageMode, validateBusyMessageModeEnv } from "./config.js";
import { runCli } from "./cli.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { standaloneServiceId } from "./executionIdentity.js";
import { logCompatibilityDiagnostics } from "./compatibilityDiagnostics.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env",
  override: false,
});

logCompatibilityDiagnostics("telegram-standalone");

function getServiceKindFromEnvFile(envPath: string): "codex" | "antigravity" | "claude" | "kimchi" | null {
  if (!envPath) return null;
  const name = basename(envPath);
  if (name.includes("codex")) return "codex";
  if (name.includes("antigravity")) return "antigravity";
  if (name.includes("gemini")) return "antigravity";
  if (name.includes("claude")) return "claude";
  if (name.includes("kimchi")) return "kimchi";
  return null;
}

const config: BridgeConfig = {
  allowedUserIds: new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
      .split(",").map(s => s.trim()).filter(Boolean)
  ),
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: getServiceKindFromEnvFile(process.env.BRIDGE_ENV_FILE || ""),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
  executionMode: resolveExecutionMode(getServiceKindFromEnvFile(process.env.BRIDGE_ENV_FILE || "") || "codex", process.env),
  busyMessageMode: resolveBusyMessageMode(process.env),
  asyncEnabled: process.env.BRIDGE_ASYNC_ENABLED !== "false",
  dbPath: process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`,
  bots: loadBotsConfig(process.env, { withTokens: true }),
};

validateBusyMessageModeEnv(process.env);
validateTokenUniqueness(
  Object.fromEntries(Object.entries(config.bots).map(([kind, bot]) => [kind, bot.token]))
);

const validation = validateBridgeConfig(config);
if (!validation.ok) {
  throw new Error(`Invalid bridge config:\n- ${validation.errors.join("\n- ")}`);
}

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});
if (soulContext) console.log(`[bridge] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openProductionDb(config.dbPath, {
  serviceId: standaloneServiceId(),
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production",
});
const advisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });

await db.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 10 * 60 * 1000),
  processState: (run) => getExecutionProcessState(run.run_id),
  onReconciled: (run) => console.warn(`[bridge] reconciled orphaned run ${run.run_id}`),
});

console.log("[bridge] starting bots...");

const engines = (Object.entries(config.bots) as [BotKind, BotConfig][])
  .filter(([, bot]) => bot.token)
  .map(([kind, botConfig]) => {
    const client = new TelegramClient(botConfig.token!, fetch, resolveTimeoutsForKind(kind).fetchTimeoutMs);
    return new BridgeEngine(
      {
        kind,
        surfaceIdentity: `telegram:${kind}`,
        botConfig,
        allowedUserIds: config.allowedUserIds,
        executionMode: resolveExecutionMode(kind, process.env),
        busyMessageMode: config.busyMessageMode,
        asyncEnabled: config.asyncEnabled,
        pollIntervalMs: config.pollIntervalMs,
        soulContext,
        fullConfig: config,
        advisorCapabilities: advisorBroker ?? undefined,
      },
      db,
      client,
    );
  });

const shutdown = async (signal: string) => {
  console.log(`[bridge] ${signal} received, shutting down...`);
  shutdownCliProcesses();
  await advisorBroker?.close();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

await Promise.all(engines.map((e) => e.run()));
