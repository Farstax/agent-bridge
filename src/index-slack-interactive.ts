/**
 * PURPOSE: Standalone Slack companion (#943): one allowlisted, Socket Mode
 * surface that routes DMs and explicit mentions into the existing
 * BridgeEngine / provider fallback / queue / delivery owners. It contains no
 * execution engine of its own.
 *
 * Environment (see .env.slack-interactive.example and docs/slack.md):
 *   SLACK_BOT_TOKEN_FILE | SLACK_BOT_TOKEN, SLACK_APP_TOKEN_FILE | SLACK_APP_TOKEN
 *   SLACK_ALLOWED_USER_IDS   required, comma-separated Slack member IDs
 *   SLACK_STATUS_FILE        optional process-local readiness file
 *   DB_PATH, INTERACTIVE_CLI_CHAIN, AGENT_BRIDGE_INSTALLATION_ID, BRIDGE_EXECUTION_MODE
 */
import dotenv from "dotenv";
import { WebClient } from "@slack/web-api";
import { getBridgeProjectDir } from "./bridge.js";
import { openProductionDb } from "./db.js";
import { getExecutionProcessState, shutdownCliProcesses } from "./cliSupervisor.js";
import { loadBotsConfig, resolveBusyMessageMode, resolveExecutionMode, validateBusyMessageModeEnv } from "./config.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import "./interactiveCliAuthStartup.js";
import { getAvailableCliKinds } from "./interactiveCliAuth.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveTurnWithFallback,
  setUserCliPreference,
  type CliKind,
} from "./interactiveBot.js";
import { runCli } from "./cli.js";
import type { BridgeConfig, BotKind } from "./types.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { parseCliChain, interactiveChainKinds } from "./providers/selection.js";
import { deriveConversationOwnerKey } from "./conversationOwnerKey.js";
import { ScheduledRoutineRunner, buildScheduledInteractiveTurn } from "./scheduledRoutines.js";
import { RunContinuationRunner, buildTelegramRunContinuationTurn } from "./runContinuation.js";
import { SlackClient } from "./slack.js";
import { loadSlackConfig, SlackConfigError } from "./slackConfig.js";
import {
  SlackIdentityError,
  VerifiedSocketModeClient,
  assertSupportedSlackTokens,
  safeSlackErrorCode,
  verifySlackBotIdentity,
} from "./slackIdentity.js";
import { slackSurfaceIdentity } from "./slackIngress.js";
import { createSlackCliCommandHandler, createSlackReceiptRuntime } from "./slackDispatch.js";
import { SlackStatusWriter, type SlackStatusErrorCode } from "./slackStatus.js";
import type { BridgeDb } from "./db.js";

dotenv.config({ path: process.env.BRIDGE_ENV_FILE || ".env.slack-interactive", override: false });

const TAG = "[slack-interactive]";

/** EX_CONFIG: a permanent misconfiguration; the unit does not restart-loop on it. */
const EXIT_CONFIG = 78;
/** Failures Slack states are permanent for the supplied credentials or allowlist. */
const PERMANENT_SLACK_ERRORS = new Set([
  "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive", "missing_scope",
  "bot_not_found", "user_not_found", "user_disabled", "team_access_not_granted", "no_permission",
]);

/** True only when Slack positively said the credentials or users are unusable. */
function isPermanentSlackFailure(error: unknown): boolean {
  return PERMANENT_SLACK_ERRORS.has(safeSlackErrorCode(error));
}

function fail(code: SlackStatusErrorCode, message: string, status: SlackStatusWriter, exitCode = EXIT_CONFIG): never {
  status.transition("failed", code);
  status.stop("failed");
  console.error(`${TAG} ${code}: ${message}`);
  process.exit(exitCode);
}

process.on("unhandledRejection", (reason) => {
  console.error(`${TAG} unhandled rejection: ${safeSlackErrorCode(reason)}`);
  status.transition("failed", "socket_error");
  status.stop("failed");
  process.exit(1);
});

// ── Config and verified identity ─────────────────────────────────────────────

let slackConfig: ReturnType<typeof loadSlackConfig>;
const status = new SlackStatusWriter(process.env.SLACK_STATUS_FILE?.trim() || null);
status.start();
try {
  slackConfig = loadSlackConfig(process.env);
} catch (error) {
  fail("token_invalid", error instanceof SlackConfigError ? error.message : "invalid Slack configuration", status);
}
status.setIdentity({ appId: "", teamId: "", botUserId: "" });
try {
  assertSupportedSlackTokens(slackConfig.botToken, slackConfig.appToken);
} catch (error) {
  fail(error instanceof SlackIdentityError && error.code === "token_class_unsupported" ? "token_class_unsupported" : "token_invalid", (error as Error).message, status);
}

// Uncertain write outcomes are surfaced, never retried by the SDK.
const apiOptions = slackConfig.apiUrl ? { slackApiUrl: slackConfig.apiUrl } : {};
const web = new WebClient(slackConfig.botToken, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15_000, ...apiOptions });
let identity: Awaited<ReturnType<typeof verifySlackBotIdentity>>;
try {
  identity = await verifySlackBotIdentity(web);
} catch (error) {
  const code = error instanceof SlackIdentityError && error.code === "identity_unavailable" ? "identity_unavailable" : "token_invalid";
  // Transport, rate-limit and 5xx failures are transient: exit 1 so the unit restarts.
  const permanent = error instanceof SlackIdentityError && error.permanent;
  fail(code, (error as Error).message, status, permanent ? EXIT_CONFIG : 1);
}
status.setIdentity({ appId: identity.appId, teamId: identity.teamId, botUserId: identity.botUserId });

for (const userId of slackConfig.allowedUserIds) {
  try {
    const info: any = await web.users.info({ user: userId });
    const user = info?.user;
    if (!user || user.is_bot || user.deleted || (user.team_id && user.team_id !== identity.teamId)) {
      fail("allowlist_invalid", "an allowlisted Slack user is a bot, deactivated or outside the verified workspace", status);
    }
  } catch (error) {
    if (isPermanentSlackFailure(error)) fail("allowlist_invalid", "an allowlisted Slack user does not exist or is disabled", status);
    fail("identity_unavailable", "could not verify the allowlist (transient Slack failure)", status, 1);
  }
}

const surfaceIdentity = slackSurfaceIdentity(identity.teamId, identity.appId);
const verifiedContext = { teamId: identity.teamId, appId: identity.appId, botUserId: identity.botUserId, allowedUserIds: new Set(slackConfig.allowedUserIds) };

// ── Engine composition (identical ownership to the Discord companion) ───────

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/slack-interactive.sqlite`;
const executionMode = resolveExecutionMode("codex", process.env);
validateBusyMessageModeEnv(process.env);
const busyMessageMode = resolveBusyMessageMode(process.env);
const engineAllowedUserIds = new Set<string>(slackConfig.allowedUserIds);
const config: BridgeConfig = {
  allowedUserIds: engineAllowedUserIds,
  serviceEnvFile: null,
  serviceKind: null,
  pollIntervalMs: 1_000,
  executionMode,
  busyMessageMode,
  dbPath,
  bots: loadBotsConfig(process.env),
};
const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});

let db: BridgeDb;
try {
  db = openProductionDb(dbPath, {
    serviceId: "slack:interactive",
    installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
    requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
    databaseRole: "slack",
  });
} catch (error) {
  fail("database_unavailable", error instanceof Error ? error.message : "database unavailable", status);
}
const advisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });

const client = new SlackClient(web as unknown as import("./slack.js").SlackPostingClient);
const cliChain = parseCliChain(process.env.INTERACTIVE_CLI_CHAIN, { allowed: interactiveChainKinds(), fallback: ["codex", "claude", "antigravity", "grok", "cursor"] });
const fallbackChain = new ProviderFallbackChain(cliChain, db, surfaceIdentity, (cli) => getAvailableCliKinds().has(cli as CliKind));
const fallbackRequests = new Map<string, import("./engine.js").ProviderFallbackReason>();

const CLI_KINDS: CliKind[] = interactiveChainKinds();
const engines = Object.fromEntries(CLI_KINDS.map((kind) => [kind, new BridgeEngine({
  kind,
  surfaceIdentity,
  botConfig: { ...config.bots[kind as BotKind], token: "" },
  allowedUserIds: engineAllowedUserIds,
  executionMode: resolveExecutionMode(kind as BotKind, process.env),
  busyMessageMode,
  pollIntervalMs: 1_000,
  soulContext,
  fullConfig: config,
  advisorCapabilities: advisorBroker ?? undefined,
  hooks: { onProviderFallbackRequested: async (chatKey, reason) => { fallbackRequests.set(chatKey, reason); } },
}, db, client)])) as Record<CliKind, BridgeEngine>;

/** Reply coordinates for a Run/queue row whose chat key is `<channel>[:<thread-ts>]`. */
function nativeCoordinates(chatKey: string): { channel: string; thread?: string } {
  const [channel, thread] = chatKey.split(":");
  return thread ? { channel, thread } : { channel };
}
async function notifyNative(channel: string, thread: string | undefined, text: string): Promise<void> {
  await client.sendMessage({ chat_id: channel, ...(thread ? { message_thread_id: thread } : {}), text })
    .catch((error) => console.warn(`${TAG} notice delivery failed`, safeSlackErrorCode(error)));
}
const dispatchDeps = (channel: string, thread: string | undefined, chatKey: string) => ({
  surfaceIdentity, engines, fallbackChain, fallbackRequests, db,
  notify: async (msg: string) => { await notifyNative(channel, thread, msg); },
  onCliSwitched: async (newCli: CliKind) => setUserCliPreference(db, { surfaceIdentity, chatKey }, newCli),
});

for (const engine of Object.values(engines)) {
  engine.setQueuedMessageHandler(async (queued) =>
    dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, dispatchDeps(String(queued.chatId), queued.threadId == null ? undefined : String(queued.threadId), queued.chatKey)));
}

// ── Admission, dispatch, recovery ────────────────────────────────────────────

const handleCliAlias = createSlackCliCommandHandler({
  db, surfaceIdentity, fallbackChain,
  available: () => getAvailableCliKinds() as ReadonlySet<CliKind>,
  hasEngine: (cli) => Boolean(engines[cli]),
  notify: notifyNative,
});

const receiptRuntime = createSlackReceiptRuntime({
  db,
  handleCommand: handleCliAlias,
  context: verifiedContext,
  authorityScope: `slack:${identity.teamId}:${identity.appId}`,
  dispatch: (turn) => dispatchInteractiveTurnWithFallback(turn, dispatchDeps(String(turn.delivery.chatId), turn.threadId, turn.chatKey)),
  notify: notifyNative,
  log: (message) => console.log(`${TAG} ${message}`),
  onAdmissionDegraded: (reason) => status.transition("connected", reason === "storage" ? "database_unavailable" : "socket_error"),
  onAdmissionRecovered: () => status.clearDegraded(),
});
let reconciliationReady: Promise<void> = Promise.resolve();

reconciliationReady = db.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 10 * 60 * 1000),
  processState: (run) => getExecutionProcessState(run.run_id),
  containmentState: (_run, processState) => processState === "absent" ? "proven" : "ambiguous",
  onReconciled: async (run) => {
    const { channel, thread } = nativeCoordinates(run.chat_id);
    await notifyNative(channel, thread, "Agent Bridge restarted. The active task was interrupted. Reply `provide update` or `continue` to resume.");
  },
}).then(() => undefined).catch((error) => {
  console.error(`${TAG} orphan reconciliation failed`, error);
  throw error;
});
receiptRuntime.gateOn(reconciliationReady);

await engines.codex.recoverPendingQueues();

// ── Scheduled routines and continuations (previously established coordinates only) ──

const scheduledOwnerKey = deriveConversationOwnerKey(surfaceIdentity, engineAllowedUserIds);
const scheduledActorId = slackConfig.allowedUserIds[0];
let scheduledRoutineRunner: ScheduledRoutineRunner | null = null;
let runContinuationRunner: RunContinuationRunner | null = null;
if (scheduledOwnerKey) {
  scheduledRoutineRunner = new ScheduledRoutineRunner(db, surfaceIdentity, async (routine, intendedAt, occurrenceKey) => {
    if (routine.ownerKey !== scheduledOwnerKey || routine.kind !== "companion") return;
    const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId, occurrenceKey);
    return await dispatchInteractiveTurnWithFallback(turn, dispatchDeps(String(turn.delivery.chatId), turn.threadId, routine.chatKey));
  });
}
runContinuationRunner = new RunContinuationRunner(db, surfaceIdentity, async (continuation) => {
  const provider = continuation.provider as CliKind;
  if (!engines[provider]) throw new Error(`continuation provider is unavailable: ${provider}`);
  fallbackChain.setActiveCli(continuation.chatKey, provider);
  const turn = buildTelegramRunContinuationTurn(continuation, scheduledActorId);
  return dispatchInteractiveTurnWithFallback(turn, dispatchDeps(String(turn.delivery.chatId), turn.threadId, continuation.chatKey), new Set([provider]));
});

// ── Socket Mode ──────────────────────────────────────────────────────────────

let socketRejected = false;
const socket = new VerifiedSocketModeClient(
  { appToken: slackConfig.appToken, autoReconnectEnabled: true, clientOptions: { retryConfig: { retries: 10, factor: 1.3 }, ...apiOptions } },
  identity.appId,
  {
    onVerified: () => undefined,
    onRejected: (code) => {
      // A token that belongs to another app is a permanent misconfiguration:
      // record it, stop serving and exit without a restart loop.
      socketRejected = true;
      scheduledRoutineRunner?.stop();
      runContinuationRunner?.stop();
      shutdownCliProcesses();
      try { db.close(); } catch { /* best effort */ }
      fail(code, "the app-level token does not belong to the verified app; refusing to serve events", status);
    },
  },
);
socket.on("connecting", () => { if (!socketRejected) status.transition("connecting"); });
socket.on("connected", () => { if (!socketRejected && socket.socketVerified) status.transition("connected"); });
socket.on("reconnecting", () => { if (!socketRejected) status.transition("reconnecting"); });
socket.on("disconnected", () => { if (!socketRejected) status.transition("disconnected"); });
for (const eventType of ["message", "app_mention"]) {
  socket.on(eventType, (args: any) => {
    receiptRuntime.handleEnvelope(args).catch((error) => console.error(`${TAG} event handling failed`, safeSlackErrorCode(error)));
  });
}

const shutdown = async (signal: string) => {
  console.log(`${TAG} ${signal} received, shutting down...`);
  scheduledRoutineRunner?.stop();
  runContinuationRunner?.stop();
  await socket.disconnect().catch(() => undefined);
  status.stop("disconnected");
  shutdownCliProcesses();
  await advisorBroker?.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

// Degradation clears itself once the database accepts work again.
const dbProbe = setInterval(() => {
  try {
    db.countEventReceipts("slack", "received");
    status.clearDegraded();
  } catch {
    status.transition("connected", "database_unavailable");
  }
}, 30_000);
dbProbe.unref();

try {
  await socket.start();
} catch (error) {
  const code = safeSlackErrorCode(error);
  console.error(`${TAG} socket start failed: ${code}`);
  if (isPermanentSlackFailure(error)) {
    status.transition("reconnect_required", "token_revoked");
    status.stop("reconnect_required");
    process.exit(EXIT_CONFIG);
  }
  // Transient: exit so the service manager restarts with fresh state.
  fail("socket_error", "socket could not be established", status, 1);
}
reconciliationReady
  .then(async () => {
    await receiptRuntime.recoverReceipts();
    scheduledRoutineRunner?.start();
    runContinuationRunner?.start();
  })
  .catch((error) => {
    console.error(`${TAG} startup recovery failed`, safeSlackErrorCode(error));
    fail("database_unavailable", "startup recovery failed", status, 1);
  });

await new Promise(() => {});
