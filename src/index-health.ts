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
import { SelfPlugin } from "./health/plugins/self.js";
import { ExternalPlugin } from "./health/plugins/external.js";
import { ServerPlugin } from "./health/plugins/server.js";
import { parseHealthEnabled, parseCadenceSeconds, parseHealthBotMode, resolveHealthTelegramToken, shouldHealthServicePoll } from "./health/config.js";
import { formatReport } from "./health/reporter.js";
import { formatAggregateReport } from "./health/reporter.js";
import { HealthReportStore } from "./health/reports.js";
import { openProductionDb } from "./db.js";
import { BridgeEngine } from "./engine.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { shutdownCliProcesses } from "./cliSupervisor.js";
import { getExecutionProcessState } from "./cliSupervisor.js";
import { autoUpdateClis } from "./health/autoRemediate.js";
import { formatQualificationSummary } from "./providers/qualificationStatus.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import { RunIngressServer, acceptRunIngressRequest, executeRunIngressRequest } from "./runIngress.js";
import { applyAuthoritativeHealthReport, pendingOwnerAuthorizedHealthRecoveryGoals, runOwnerAuthorizedHealthRecovery, startOwnerAuthorizedHealthRecovery, type OwnerAuthorizedHealthRecoveryRequest } from "./autonomousGoalRuntime.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import type { BotKind } from "./types.js";
import { loadBotsConfig, resolveExecutionMode } from "./config.js";
import { parseProviderLock } from "./providerLock.js";
import type { HealthPlugin, HealthReport } from "./health/types.js";
import {
  acceptHealthOpsEvent,
  executeHealthOpsRun,
  resumeDurablePendingHealthEvents,
  reconcileEventReceiptResult,
  HealthOpsRunLaneUnavailableError,
} from "./health/eventIngress.js";
import {
  healthRedEpisodeIdempotencyKey,
  reconcileTerminalPendingHealthEvents,
  replayablePendingHealthRunIds,
  reconcileAbandonedHealthLeases,
} from "./health/eventRecovery.js";

// ── Config ──────────────────────────────────────────────────────────────────
dotenv.config({ path: process.env.BRIDGE_ENV_FILE || ".env", override: false });


const healthBotMode = parseHealthBotMode(process.env);
const token = resolveHealthTelegramToken(process.env);
if (!token) {
  throw new Error(`${healthBotMode === "integrated" ? "TELEGRAM_BOT_TOKEN_INTERACTIVE" : "TELEGRAM_BOT_TOKEN_HEALTH"} is required for the health bot service`);
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
const cliBot: BotKind = parseProviderLock(process.env.BRIDGE_PROVIDER_LOCK) ?? "claude";
const cliBotConfig = loadBotsConfig(process.env)[cliBot];

const dbPath = process.env.HEALTH_DB_PATH || "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";

// ── Infrastructure ───────────────────────────────────────────────────────────
const bridgeDb = openProductionDb(dbPath, {
  serviceId: "telegram:health",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "health",
});
const rawDb = bridgeDb.raw;
const healthReportStore = new HealthReportStore(rawDb);
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
let engine: BridgeEngine;
const activeHealthEventRuns = new Set<number>();

const waitForHealthLane = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A newer health Run may legitimately take the shared health lane before a
// crashed, provider-started predecessor can be reconciled. Once any live
// health execution releases that lane, give older marked Runs one bounded
// reconciliation opportunity. Exact lock-identity checks in eventRecovery
// ensure this can never release a different execution's fence.
async function reconcileInterruptedHealthRunsAfterExecution(): Promise<void> {
  try {
    await reconcileAbandonedHealthLeases(bridgeDb, {
      processState: (runId) => getExecutionProcessState(runId),
      onReconciled: (run) => console.warn(`[health-bot] reconciled interrupted health run ${run.run_id} after lane release`),
    });
    reconcileTerminalPendingHealthEvents(bridgeDb);
  } catch (error) {
    console.error("[health-bot] post-execution health reconciliation failed", error);
  }
}

async function executeAcceptedHealthEvent(receiptId: number): Promise<void> {
  if (activeHealthEventRuns.has(receiptId)) return;
  activeHealthEventRuns.add(receiptId);
  try {
    for (;;) {
      try {
        await executeHealthOpsRun(bridgeDb, receiptId, engine, { bot: cliBot });
        reconcileEventReceiptResult(bridgeDb, receiptId);
        return;
      } catch (error) {
        if (!(error instanceof HealthOpsRunLaneUnavailableError)) {
          console.error(`[health-bot] event-owned health run failed receipt=${receiptId}`, error);
          reconcileEventReceiptResult(bridgeDb, receiptId);
          return;
        }
        // A receipt already owns a Run. Keep it runnable until the single
        // health lane is free, then execute that same Run.
        await waitForHealthLane(1000);
      }
    }
  } finally {
    activeHealthEventRuns.delete(receiptId);
    await reconcileInterruptedHealthRunsAfterExecution();
  }
}

async function handleHealthReportEventIngress(report: HealthReport): Promise<void> {
  const previousReport = healthReportStore.getReport(report.pluginName);
  const eventToken = process.env.HEALTH_EVENT_TOKEN;
  const crossedIntoRed = report.status === "red" && previousReport?.status !== "red";

  if (eventToken && crossedIntoRed) {
    try {
      // Anchor idempotency to the last durable predecessor. If the process
      // dies after receipt acceptance but before this red report is saved,
      // the same predecessor reproduces the same key after restart.
      const eventId = healthRedEpisodeIdempotencyKey(report.pluginName, previousReport);
      const accepted = acceptHealthOpsEvent(bridgeDb, {
        eventId,
        idempotencyKey: eventId,
        occurredAt: report.timestamp,
        report,
        token: eventToken,
      }, { expectedToken: eventToken, bot: cliBot });
      // Start from the durable receipt immediately; report delivery/persistence
      // remains independent and cannot strand accepted work.
      void executeAcceptedHealthEvent(accepted.receiptId);
    } catch (error) {
      console.error(`[health-bot] event-owned health run failed for ${report.pluginName}`, error);
    }
  }

  healthReportStore.saveReport(report);
  const statusChanged = previousReport?.status !== report.status;
  const shouldNotify = statusChanged && (report.status !== "green" || previousReport !== null);
  if (shouldNotify) await sendText(formatReport(report));

  for (const goalId of applyAuthoritativeHealthReport(bridgeDb, report)) {
    void runOwnerAuthorizedHealthRecovery(bridgeDb, goalId, engine).catch((error) =>
      console.error(`[health-bot] successor recovery execution failed for ${goalId}`, error));
  }
}

const scheduler = new HealthScheduler({
  plugins,
  config: {
    enabled: healthEnabled,
    cadenceSeconds,
    silenceOnGreen: true,
  },
  sendReport: async () => {},
  onRawReport: async (report) => {
    await handleHealthReportEventIngress(report);
    const _repoRoot = process.env.BRIDGE_PROJECT_DIR
      ?? new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
    await autoUpdateClis(report, {
      upgradeScript: `${_repoRoot}/scripts/upgrade.sh`,
      sendNotification: sendText,
      bridgeCommit: process.env.AGENT_BRIDGE_COMMIT ?? process.env.BRIDGE_COMMIT ?? process.env.BRIDGE_RELEASE_COMMIT,
    });
  },
});

// ── BridgeEngine with health hooks ───────────────────────────────────────────
engine = new BridgeEngine(
  {
    kind: "health",
    surfaceIdentity: "health",
    executionKind: cliBot,
    botConfig: { command: cliBotConfig.command, modelPreference: cliBotConfig.modelPreference },
    allowedUserIds,
    executionMode: resolveExecutionMode(cliBot, process.env),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 1000),
    soulContext,
    hooks: {
      onCommand: async (cmd, ctx) => {
        if (cmd === "/health") {
          await engine.sendText(ctx.chatId, { text: "Checking health..." });
          const results = await Promise.all(plugins.map(p => p.check()));
          const qualificationStatus = formatQualificationSummary();
          const combined = [
            ...results.map(r => formatReport(r)),
            qualificationStatus,
          ].join("\n\n---\n\n");
          for (const report of results) {
            await handleHealthReportEventIngress(report);
            await autoUpdateClis(report, {
              upgradeScript: `${process.env.BRIDGE_PROJECT_DIR ?? process.cwd()}/scripts/upgrade.sh`,
              sendNotification: sendText,
              bridgeCommit: process.env.AGENT_BRIDGE_COMMIT ?? process.env.BRIDGE_COMMIT ?? process.env.BRIDGE_RELEASE_COMMIT,
            });
          }
          return { text: combined || "✅ All checks passed." };
        }

        if (cmd === "/status") {
          const aggregate = healthReportStore.getAggregate({
            activePluginNames: plugins.map((plugin) => plugin.name),
            freshnessSeconds: cadenceSeconds * 2,
          });
          if (aggregate.status === null && !aggregate.evidence.stalePluginNames.length) {
            return { text: `No health data yet. Use /health to run a check.\n\n${formatQualificationSummary()}` };
          }
          return { text: `${formatAggregateReport(aggregate)}\n\n${formatQualificationSummary()}` };
        }

        return null;
      },
    },
  },
  bridgeDb,
  client,
);

const runIngressSocket = process.env.BRIDGE_RUN_INGRESS_SOCKET;
const runIngressToken = process.env.BRIDGE_RUN_INGRESS_TOKEN;
const runIngress = runIngressSocket && runIngressToken
  ? new RunIngressServer({
    socketPath: runIngressSocket,
    expectedToken: runIngressToken,
    accept: (request) => acceptRunIngressRequest(bridgeDb, request, { expectedToken: runIngressToken, bot: cliBot }),
    execute: (receiptId) => executeRunIngressRequest(bridgeDb, receiptId, engine, { bot: cliBot }),
    ownerAction: async (request) => {
      const recovery = request.recovery as OwnerAuthorizedHealthRecoveryRequest;
      const result = await startOwnerAuthorizedHealthRecovery(bridgeDb, recovery, engine);
      return { runId: result.runId ?? `goal:${result.goalId}`, status: result.status === "cancelled" ? "cancelled" : "done", result: JSON.stringify({ goalId: result.goalId, status: result.status }) };
    },
  })
  : null;
if (runIngress) await runIngress.start();

// Correlate terminal receipts before replay. Never-started pending Runs are
// then dispatched without blocking scheduler startup and are temporarily
// excluded from generic orphan classification while they acquire that lane.
for (const goalId of pendingOwnerAuthorizedHealthRecoveryGoals(bridgeDb)) {
  void runOwnerAuthorizedHealthRecovery(bridgeDb, goalId, engine).catch((error) =>
    console.error(`[health-bot] pending recovery execution failed for ${goalId}`, error));
}
reconcileTerminalPendingHealthEvents(bridgeDb);
const replayableHealthRunIds = replayablePendingHealthRunIds(bridgeDb);
void resumeDurablePendingHealthEvents(bridgeDb, engine, { bot: cliBot })
  .then(() => reconcileInterruptedHealthRunsAfterExecution())
  .catch((error) => {
    console.error("[health-bot] durable health event replay failed", error);
  });
await bridgeDb.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 60_000),
  processState: (run) => getExecutionProcessState(run.run_id),
  containmentState: (run, state) => replayableHealthRunIds.has(run.run_id)
    ? "ambiguous"
    : state === "absent" ? "proven" : "ambiguous",
  onReconciled: (run) => console.warn(`[health-bot] reconciled orphaned run ${run.run_id}`),
});
// Runs that reached the provider boundary are deliberately excluded from
// replay, but a crash seconds after that marker was written leaves both the
// marker and the health execution lane's lock durable — both younger than
// the generic cutoff above, and the lock alone would keep generic orphan
// containment from ever treating the lane as free. Release an abandoned
// lease and terminalize the Run through the same lease/stale-lock and
// orphan-containment semantics, so an immediate restart can't leave one
// 'running' forever with no later pass to catch it.
//
// This only runs once, here, at startup — if the owning process is already
// proven gone but its lock's lease simply hasn't expired yet, nothing above
// can reconcile it, and no later pass would either. scheduleRetry arranges
// exactly one bounded setTimeout for when that lease will have expired; the
// retry itself passes no scheduleRetry, so it can never reschedule itself
// into a loop.
await reconcileAbandonedHealthLeases(bridgeDb, {
  processState: (runId) => getExecutionProcessState(runId),
  onReconciled: (run) => console.warn(`[health-bot] reconciled interrupted health run ${run.run_id}`),
  scheduleRetry: (delayMs) => {
    console.warn(`[health-bot] abandoned health lease not yet stale, retrying reconciliation in ${delayMs}ms`);
    setTimeout(() => {
      reconcileAbandonedHealthLeases(bridgeDb, {
        processState: (runId) => getExecutionProcessState(runId),
        onReconciled: (run) => console.warn(`[health-bot] reconciled interrupted health run ${run.run_id} on retry`),
      })
        .then(() => reconcileTerminalPendingHealthEvents(bridgeDb))
        .catch((error) => console.error("[health-bot] deferred health lease reconciliation failed", error));
    }, delayMs);
  },
});
reconcileTerminalPendingHealthEvents(bridgeDb);

// ── Start ────────────────────────────────────────────────────────────────────
console.log("[health-bot] starting...");
// A scheduler-only integrated service must stay resident even when scheduling
// is disabled (the default); an unsettled promise alone does not keep Node up.
const schedulerOnlyKeepalive = shouldHealthServicePoll(process.env)
  ? null
  : setInterval(() => {}, 60_000);

if (shouldHealthServicePoll(process.env)) {
  await client.setMyCommands({
    commands: [
      { command: "health", description: "Run health checks immediately" },
      { command: "status", description: "Show current health status" },
      { command: "stop", description: "Abort running execution" },
    ],
  }).catch((err) => console.warn(`[health-bot] setMyCommands failed`, err));
}

if (healthEnabled) {
  scheduler.start();
  for (const plugin of plugins) {
    scheduler.runPlugin(plugin).catch((err: unknown) =>
      console.error("[health-bot] startup check error", err)
    );
  }
  console.log(`[health-bot] scheduler started — cadence ${cadenceSeconds}s`);
}

const shutdown = (signal: string) => {
  console.log(`[health-bot] ${signal} received, shutting down...`);
  if (schedulerOnlyKeepalive) clearInterval(schedulerOnlyKeepalive);
  scheduler.stop();
  shutdownCliProcesses();
  void runIngress?.close();
  rawDb.close();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

if (shouldHealthServicePoll(process.env)) {
  await engine.run();
} else {
  console.log("[health-bot] integrated mode: scheduler is send-only; interactive bot owns Telegram polling");
}
