/**
 * PURPOSE: Entry point for the unified Telegram runtime.
 * One interactive Telegram bot polls for messages and supports provider switching.
 * NEIGHBORS: src/config.ts, src/interactiveBot.ts, src/engine.ts, src/db.ts
 */

import { join } from "node:path";
import { getBridgeProjectDir } from "./bridge.js";
import { loadInteractiveEnvFile } from "./interactiveEnv.js";
import { openProductionDb } from "./db.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { loadBotsConfig, resolveExecutionMode, resolveBusyMessageMode, resolveExecutionCapacityConfig, resolveAutonomyRuntimeConfig, validateBusyMessageModeEnv } from "./config.js";
import { openExecutionCapacityCoordinator } from "./executionCapacity.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import { parseCliChain, interactiveChainKinds } from "./providers/selection.js";
import "./interactiveCliAuthStartup.js";
import { getCachedAvailableCliKinds as getAvailableCliKinds } from "./interactiveCliAuth.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  buildCliStatusText,
  buildCliKeyboard,
  handleCliSwitchCallback,
  buildGlobalInteractiveCommandRegistrations,
  buildChatInteractiveCommandRegistrations,
  resolveUpdateChatKey,
  resolveMessageThreadId,
  isAuthorizedInteractiveUpdate,
  describeInteractiveUpdateForLog,
  isGroupInteractiveUpdate,
  dispatchInteractiveTurnWithFallback,
  dispatchUnifiedTelegramUpdate,
  handleUnavailableCliUpdate,
  dispatchClaimedInteractiveWithFallback,
  resolveAvailableCliPreference,
  switchManualCli,
  handleInteractiveCliCommand,
  runUnifiedTelegramIngress,
  resumeCapacityHeldQueue,
  type CliKind,
} from "./interactiveBot.js";
import { isAcpConfigControlCommand, prepareInteractiveAcpConfigControl } from "./interactiveAcpConfig.js";
import { targetTelegramAbortUpdate } from "./telegramCommandTarget.js";
import { toUserMessage } from "./cli.js";
import { getExecutionProcessState } from "./cliSupervisor.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";
import { SensorRegistry } from "./sensors/registry.js";
import { buildSensorsKeyboard, handleSensorCallback, isSensorsCommand } from "./sensors/telegram.js";
import { RunIngressServer, acceptRunIngressRequest, executeRunIngressRequest } from "./runIngress.js";
import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";
import { deriveConversationOwnerKey } from "./conversationOwnerKey.js";
import { loadWorkspaceContext } from "./workspaceContext.js";
import { AutonomyController, isFirstClassAutonomyBot } from "./autonomyController.js";
import { matchAutonomousTelegramSupervisorReply, parseAutonomyTelegramCommand } from "./autonomyTelegram.js";
import { AUTONOMOUS_RUN_SURFACE } from "./autonomousGoalRuntime.js";
import {
  ScheduledRoutineRunner,
  buildScheduledInteractiveTurn,
} from "./scheduledRoutines.js";
import {
  RunContinuationRunner,
  buildTelegramRunContinuationTurn,
} from "./runContinuation.js";
import { fetchCodexCapacityResetAt } from "./codexUsage.js";
import { createCapacityFallbackRequestedHook } from "./providers/capacityFallbackHook.js";
import { recoveryCopySurfaceIdentity } from "./db/recoveryCopyIsolation.js";
import { admitInteractivePolledUpdate, INTERACTIVE_POLL_RECEIPT_SOURCE } from "./telegramPollAdmission.js";

loadInteractiveEnvFile();

const supportedCliKinds = interactiveChainKinds();
const configuredCliChain = parseCliChain(
  process.env.INTERACTIVE_CLI_CHAIN,
  { allowed: supportedCliKinds, fallback: ["codex", "claude", "antigravity", "grok", "cursor"] },
);
const token = process.env.TELEGRAM_BOT_TOKEN_INTERACTIVE;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN_INTERACTIVE is required");

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = resolveExecutionMode("codex", process.env);
validateBusyMessageModeEnv(process.env);
const busyMessageMode = resolveBusyMessageMode(process.env);
const executionCapacity = resolveExecutionCapacityConfig(process.env);
const {
  enabled: autonomyEnabled,
  dir: autonomyDir,
  dbPath: autonomyDbPath,
  maxCycles: autonomyMaxCycles,
} = resolveAutonomyRuntimeConfig(process.env);

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: null,
  pollIntervalMs,
  executionMode,
  busyMessageMode,
  dbPath,
  bots: loadBotsConfig(process.env),
};

const soulContext = loadSoulContext({
  mode: normalizeSoulMode(process.env.AGENT_BRIDGE_SOUL_MODE),
  path: process.env.AGENT_BRIDGE_SOUL_PATH || defaultSoulPath(getBridgeProjectDir()),
});
if (soulContext) console.log(`[interactive] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openProductionDb(dbPath, {
  serviceId: "telegram:interactive",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
});
const surfaceIdentity = recoveryCopySurfaceIdentity(db.raw, "telegram:interactive");
const executionCapacityDb = openExecutionCapacityCoordinator(executionCapacity, dbPath, db, {
  serviceId: "telegram:interactive",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
});
const client = new TelegramClient(
  token,
  fetch,
  resolveTimeoutsForKind("codex").fetchTimeoutMs,
);
const autonomyDb = autonomyDbPath ? openProductionDb(autonomyDbPath, {
  serviceId: "telegram:interactive-autonomy",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
}) : null;
const ownerNotificationSocketPath = process.env.BRIDGE_OWNER_NOTIFICATION_SOCKET?.trim();
const ownerNotificationIngress = ownerNotificationSocketPath
  ? await startOwnerNotificationIngress({
      socketPath: ownerNotificationSocketPath,
      allowedUserIds,
      client: {
        sendMessage: (chatId, text) => client.sendMessage({ chat_id: chatId, text }),
      },
      recordDeliveredAssistantTurn: (chatKey, text) => {
        const ownerKey = deriveConversationOwnerKey(surfaceIdentity, allowedUserIds);
        db.addConvTurn(chatKey, "assistant", text, undefined, {
          surfaceIdentity: surfaceIdentity,
          ...(ownerKey ? { ownerKey } : {}),
        });
      },
    })
  : null;
if (ownerNotificationIngress) {
  console.log(`[interactive] owner notification ingress listening on ${ownerNotificationSocketPath}`);
}
const sensorRegistry = new SensorRegistry({ db, dbPath, env: process.env });

await db.reconcileOrphanedRuns({
  candidateRuns: db.listRunningRuns(surfaceIdentity),
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 10 * 60 * 1000),
  processState: (run) => getExecutionProcessState(run.run_id),
  containmentState: (_run, processState) => processState === "absent" ? "proven" : "ambiguous",
  onReconciled: async (run) => {
    const parts = run.chat_id.split(":");
    const chatId = Number(parts[0]);
    const threadId = parts.length > 1 ? Number(parts[1]) : undefined;
    if (!Number.isNaN(chatId)) {
      await sendTelegramMessage({
        client,
        kind: "interactive",
        chatId,
        body: {
          text: "⚠️ **Agent bridge restarted.** The active task was interrupted. You can reply with `provide update` or `continue` to resume.",
          message_thread_id: threadId,
        },
      }).catch((err) => console.error(`Failed to send restart notification to ${run.chat_id}`, err));
    }
  },
});
let botUsername = process.env.TELEGRAM_BOT_USERNAME || null;
if (!botUsername) {
  try {
    const me = await client.call<{ username?: string }>("getMe");
    botUsername = me.result.username ?? null;
  } catch (err) {
    console.warn("[interactive] getMe failed; group-suffixed /cli commands disabled", err);
  }
}

const fallbackChain = new ProviderFallbackChain(
  configuredCliChain,
  db,
  surfaceIdentity,
  (cli) => getAvailableCliKinds().has(cli as CliKind),
);
const fallbackRequests = new Map<string, import("./engine.js").ProviderFallbackReason>();
const capacityFallbackAttempts = new Map<string, { runId: string; chatId: number | string; chatType: string; threadId?: number | string; provider?: CliKind; retryAfterSeconds?: number; hasUnknownCapacityTiming?: true }>();

function resolveCredentialCheckedPreference(chatKey: string): { pref: CliKind | null; available: Set<CliKind>; stored: CliKind } {
  const detected = getAvailableCliKinds();
  const stored = getUserCliPreference(db, { surfaceIdentity: surfaceIdentity, chatKey });
  const pref = resolveAvailableCliPreference(stored, detected);
  if (pref && pref !== stored) {
    setUserCliPreference(db, { surfaceIdentity: surfaceIdentity, chatKey }, pref);
    fallbackChain.setActiveCli(chatKey, pref);
  }
  return { pref, available: detected, stored };
}

const engines = Object.fromEntries(
  supportedCliKinds.map((kind) => {
    const botConfig = kind === "custom-acp"
      ? { command: "", modelPreference: [], token }
      : { ...config.bots[kind], token };
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          surfaceIdentity: surfaceIdentity,
          isolatedConversationDirectories: true,
          botConfig,
          allowedUserIds,
          executionMode: resolveExecutionMode(kind, process.env),
          busyMessageMode,
          pollIntervalMs,
          soulContext,
          fullConfig: config,
          maxConcurrentExecutions: executionCapacity.maxConcurrentExecutions,
          executionCapacityDb: executionCapacityDb ?? undefined,
          hooks: {
            onCommand: async (commandText, ctx) => {
              if (!isAcpConfigControlCommand(commandText)) return null;
              try {
                await prepareInteractiveAcpConfigControl({
                  kind,
                  commandText,
                  surfaceIdentity: surfaceIdentity,
                  chatKey: ctx.chatKey,
                  db,
                  executionMode: resolveExecutionMode(kind, process.env),
                });
                return null;
              } catch (error) {
                const userText = toUserMessage(error instanceof Error ? error : new Error(String(error)));
                return { text: `Unable to load live ACP settings for ${kind}: ${userText}` };
              }
            },
            onProviderFallbackRequested: createCapacityFallbackRequestedHook(kind, {
              fallbackRequests,
              capacityFallbackAttempts,
              fetchCodexCapacityResetAt,
            }),
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<CliKind, BridgeEngine>;

const defaultPref = resolveAvailableCliPreference(getUserCliPreference(db, { surfaceIdentity: surfaceIdentity, chatKey: "default" }), getAvailableCliKinds())
  ?? "codex";

const runIngressSocket = process.env.BRIDGE_RUN_INGRESS_SOCKET?.trim();
const runIngressToken = process.env.BRIDGE_RUN_INGRESS_TOKEN?.trim();
const runIngress = runIngressSocket && runIngressToken
  ? new RunIngressServer({
      socketPath: runIngressSocket,
      expectedToken: runIngressToken,
      accept: (request) => acceptRunIngressRequest(db, request, { expectedToken: runIngressToken, bot: defaultPref }),
      execute: (receiptId) => executeRunIngressRequest(db, receiptId, engines[defaultPref], { bot: defaultPref }),
    })
  : null;
if (runIngress) {
  await runIngress.start();
  console.log(`[interactive] run ingress listening on ${runIngressSocket}`);
}

let shuttingDown = false;
const shutdownInteractive = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void Promise.allSettled([
    ownerNotificationIngress?.stop() ?? Promise.resolve(),
    runIngress?.close() ?? Promise.resolve(),
  ]).finally(() => process.exit(0));
};
process.once("SIGINT", shutdownInteractive);
process.once("SIGTERM", shutdownInteractive);

const AUTONOMY_CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const autonomyWorkspaceContext = autonomyDir
  ? loadWorkspaceContext({ ...process.env, AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: join(autonomyDir, "CONTEXT.md") })
  : "";
const autonomySoulContext = autonomyDir
  ? loadSoulContext({ mode: "summary", path: join(autonomyDir, "SOUL.md") })
  : null;
const autonomyEngines = autonomyDb && autonomyDir ? Object.fromEntries(
  AUTONOMY_CLI_KINDS.map((kind) => [kind, new BridgeEngine({
    kind: "autonomous",
    surfaceIdentity: AUTONOMOUS_RUN_SURFACE,
    executionKind: kind as BotKind,
    botConfig: config.bots[kind as BotKind],
    allowedUserIds,
    executionMode: resolveExecutionMode(kind as BotKind, process.env),
    maxConcurrentExecutions: executionCapacity.maxConcurrentExecutions,
    executionCapacityDb: executionCapacityDb ?? undefined,
    pollIntervalMs,
    soulContext: autonomySoulContext,
    workingDir: join(autonomyDir, "work"),
    workspaceContext: autonomyWorkspaceContext,
    // Keep the shared scratch helper scoped to the autonomy database, not the
    // interactive service database.
    fullConfig: { ...config, dbPath: autonomyDbPath! },
  }, autonomyDb, client)]),
) as Record<CliKind, BridgeEngine> : null;
const autonomyController = autonomyDb && autonomyDir && autonomyEngines ? new AutonomyController({
  db: autonomyDb,
  isProviderAvailable: (provider) => getAvailableCliKinds().has(provider as CliKind),
  autonomyDir,
  maxCycles: autonomyMaxCycles,
  engineForBot: (bot) => {
    const engine = autonomyEngines[bot as CliKind];
    if (!engine) throw new Error(`provider ${bot} is not available for first-class autonomy`);
    return engine;
  },
  deliverSupervisorMessage: async (route, text) => {
    if (route.surface !== "telegram") throw new Error(`unsupported autonomy supervisor surface: ${route.surface}`);
    const chatId = Number(route.address);
    if (!Number.isSafeInteger(chatId)) throw new Error("invalid Telegram autonomy supervisor chat");
    const thread = route.thread === undefined ? undefined : Number(route.thread);
    if (thread !== undefined && !Number.isSafeInteger(thread)) throw new Error("invalid Telegram autonomy supervisor thread");
    const sent = await client.sendMessage({ chat_id: chatId, text, ...(thread === undefined ? {} : { message_thread_id: thread }) });
    const messageId = sent.result?.message_id;
    if (!Number.isSafeInteger(messageId)) throw new Error("Telegram supervisor message did not return message_id");
    return messageId!;
  },
  log: console,
}) : null;
autonomyController?.resumeActive();

async function registerGlobalCommands(pref: CliKind, label: string): Promise<void> {
  for (const body of buildGlobalInteractiveCommandRegistrations(pref, { autonomy: autonomyEnabled })) {
    const scopeName = body.scope?.type ?? "default";
    await client.setMyCommands(body)
      .catch((err: unknown) => console.warn(`[interactive] setMyCommands (${scopeName}) failed${label}`, err));
  }
}

async function registerGroupChatCommands(pref: CliKind, chatId: number): Promise<void> {
  for (const body of buildChatInteractiveCommandRegistrations(pref, chatId, { autonomy: autonomyEnabled })) {
    const scopeName = body.scope?.type ?? "chat";
    await client.setMyCommands(body)
      .catch((err: unknown) => console.warn(`[interactive] setMyCommands (${scopeName} ${chatId}) failed`, err));
  }
}

for (const engine of Object.values(engines)) {
  engine.setQueuedMessageHandler(async (queued) => {
    const chatKey = queued.chatKey;
    return dispatchClaimedInteractiveWithFallback(queued, chatKey, {
      surfaceIdentity: surfaceIdentity, engines, fallbackChain, fallbackRequests, capacityFallbackAttempts, db,
      notify: async (msg) => {
        await sendTelegramMessage({ client, kind: "interactive", chatId: queued.chatId, body: { text: msg, message_thread_id: queued.threadId ?? undefined } });
      },
      onCliSwitched: async (newCli) => {
        await registerGlobalCommands(newCli, " during queued fallback");
        if (queued.chatType === "group" || queued.chatType === "supergroup") {
          const groupChatId = typeof queued.chatId === "number" ? queued.chatId : Number(queued.chatId);
          if (Number.isSafeInteger(groupChatId)) await registerGroupChatCommands(newCli, groupChatId);
        }
      },
    });
  });
}

await runUnifiedTelegramIngress({
  recoverPendingQueues: () => engines[defaultPref].recoverPendingQueues(),
  onRecoveryError: (error) => console.error("[interactive] startup queue recovery failed", error),
  runIngress: runInteractiveIngress,
});

async function runInteractiveIngress(): Promise<void> {
const scheduledOwnerKey = deriveConversationOwnerKey(surfaceIdentity, allowedUserIds);
const scheduledActorId = allowedUserIds.values().next().value;
const scheduledRoutineRunner = scheduledOwnerKey && scheduledActorId ? new ScheduledRoutineRunner(
  db,
  surfaceIdentity,
  async (routine, intendedAt, occurrenceKey) => {
    if (routine.ownerKey !== scheduledOwnerKey) {
      console.warn(`[scheduled-routines] owner mismatch for ${routine.id}; occurrence skipped`);
      return;
    }
    // Runtime dispatch always receives a routine normalized by parseRoutine()
    // (every listScheduledRoutines()/dispatch callback row), which has already
    // populated `delivery` -- including a one-time legacy decode for pre-v18
    // records. Dispatch itself must never re-derive delivery from chatKey.
    if (!routine.delivery) throw new Error(`scheduled routine has no delivery coordinates: ${routine.id}`);
    const destination = routine.delivery;
    const sendNotice = async (text: string) => {
      await sendTelegramMessage({
        client,
        kind: "interactive",
        chatId: destination.chatId,
        body: { text, message_thread_id: destination.threadId },
      });
    };

    if (routine.kind === "autonomous") {
      if (!autonomyController) {
        await sendNotice(`Scheduled autonomous routine **${routine.name}** was skipped because autonomy is not configured.`);
        return;
      }
      if (autonomyController.status().state === "running") {
        await sendNotice(`Scheduled autonomous routine **${routine.name}** was skipped because another autonomous Episode is already running.`);
        return;
      }
      const { pref } = resolveCredentialCheckedPreference(routine.chatKey);
      if (!pref || !isFirstClassAutonomyBot(pref)) {
        await sendNotice(`Scheduled autonomous routine **${routine.name}** was skipped because no supported autonomous provider is currently available.`);
        return;
      }
      const started = await autonomyController.start({
        bot: pref,
        policyInstruction: `[Scheduled routine: ${routine.name}]\n${routine.instruction}`,
        supervisorRoute: {
          surface: "telegram",
          address: String(destination.chatId),
          identity: scheduledActorId,
          ...(destination.threadId === undefined ? {} : { thread: String(destination.threadId) }),
        },
      });
      if (!started.created) {
        await sendNotice(`Scheduled autonomous routine **${routine.name}** was skipped because another autonomous Episode became active.`);
      }
      return;
    }

    const turn = buildScheduledInteractiveTurn(routine, intendedAt, scheduledActorId, occurrenceKey);
    return await dispatchInteractiveTurnWithFallback(turn, {
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: sendNotice,
      onCliSwitched: async (newCli) => {
        await registerGlobalCommands(newCli, " during scheduled fallback");
        if (Number(destination.chatId) < 0) await registerGroupChatCommands(newCli, Number(destination.chatId));
      },
    });
  },
) : null;
scheduledRoutineRunner?.start();

const runContinuationRunner = scheduledActorId ? new RunContinuationRunner(
  db,
  surfaceIdentity,
  async (continuation) => {
    if (continuation.capacityWait) {
      return resumeCapacityHeldQueue(continuation, { engines, fallbackChain, db });
    }
    const provider = continuation.provider as CliKind;
    if (!engines[provider]) throw new Error(`continuation provider is unavailable: ${provider}`);
    fallbackChain.setActiveCli(continuation.chatKey, provider);
    const turn = buildTelegramRunContinuationTurn(continuation, scheduledActorId);
    return dispatchInteractiveTurnWithFallback(turn, {
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: async (msg) => {
        await sendTelegramMessage({
          client,
          kind: "interactive",
          chatId: turn.delivery.chatId,
          body: { text: msg, message_thread_id: turn.threadId === undefined ? undefined : Number(turn.threadId) },
        });
      },
      onCliSwitched: async (newCli) => {
        await registerGlobalCommands(newCli, " during continuation fallback");
        if (typeof turn.delivery.chatId === "number" && turn.delivery.chatId < 0) {
          await registerGroupChatCommands(newCli, turn.delivery.chatId);
        }
      },
    }, new Set([provider]));
  },
  undefined,
  {
    onCapacityExpired: async (continuation) => {
      const delivery = continuation.delivery;
      if (!delivery) return;
      await sendTelegramMessage({
        client,
        kind: "interactive",
        chatId: delivery.chatId,
        body: { text: "I could not retry your task before the provider recovery window expired. Please send it again when you are ready.", message_thread_id: delivery.threadId === undefined ? undefined : Number(delivery.threadId) },
      });
    },
  },
) : null;
runContinuationRunner?.start();

await registerGlobalCommands(defaultPref, "");
const registeredGroupChats = new Set<number>();

console.log("[interactive] starting polling...");

let offset = db.getLastUpdateId("codex");
const POLL_KIND = "codex";

async function processAdmittedInteractiveUpdate(
  update: TelegramUpdate,
  onDeferred: (operation: Promise<unknown>) => void,
): Promise<void> {
  try {
        let typedUpdate = update as TelegramUpdate;
        const isGroupUpdate = isGroupInteractiveUpdate(typedUpdate);
        if (isGroupUpdate) {
          console.log("[interactive] update.received", JSON.stringify(describeInteractiveUpdateForLog(typedUpdate)));
        }

        const groupChatId = isGroupUpdate
          ? (typedUpdate.message?.chat?.id ?? typedUpdate.callback_query?.message?.chat?.id ?? null)
          : null;
        if (groupChatId != null && !registeredGroupChats.has(groupChatId)) {
          registeredGroupChats.add(groupChatId);
          const { pref: groupPref } = resolveCredentialCheckedPreference(String(groupChatId));
          registerGroupChatCommands(groupPref ?? defaultPref, groupChatId);
        }

        if (!isAuthorizedInteractiveUpdate(typedUpdate, allowedUserIds)) {
          if (isGroupUpdate) {
            console.warn("[interactive] update.ignored", JSON.stringify({
              ...describeInteractiveUpdateForLog(typedUpdate),
              reason: typedUpdate.message?.sender_chat && !typedUpdate.message?.from ? "anonymous_sender_chat" : "unauthorized_user",
            }));
          }
          return;
        }

        const targetedUpdate = targetTelegramAbortUpdate(typedUpdate, botUsername);
        if (!targetedUpdate) return;
        typedUpdate = targetedUpdate;

        const message = typedUpdate.message;
        if (message) {
          const rawText = (message.text || "").trim();
          const chatId = message.chat.id;
          const chatKey = resolveUpdateChatKey(typedUpdate) ?? String(chatId);

          const autonomyCommand = parseAutonomyTelegramCommand(rawText, botUsername);
          if (autonomyCommand) {
            if (!autonomyController) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "Autonomy is not configured on this runtime.", message_thread_id: message.message_thread_id } });
              return;
            }
            if (autonomyCommand === "status") {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              return;
            }
            if (autonomyCommand === "stop") {
              await autonomyController.stop("authenticated owner /autonomy stop");
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              return;
            }
            const { pref } = resolveCredentialCheckedPreference(chatKey);
            if (!pref) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "No authenticated CLI is available to start autonomy.", message_thread_id: message.message_thread_id } });
              return;
            }
            if (!isFirstClassAutonomyBot(pref)) {
              await sendTelegramMessage({
                client,
                kind: "interactive",
                chatId,
                body: {
                  text: `${pref} does not support first-class autonomy yet. Switch to Codex, Claude, or Antigravity, then /autonomy approve.`,
                  message_thread_id: message.message_thread_id,
                },
              });
              return;
            }
            const started = await autonomyController.start({
              bot: pref,
              policyInstruction: "Authenticated owner approved this Episode via /autonomy approve.",
              supervisorRoute: {
                surface: "telegram",
                address: String(chatId),
                identity: String(message.from!.id),
                ...(message.message_thread_id === undefined ? {} : { thread: String(message.message_thread_id) }),
              },
            });
            const text = started.created ? `Autonomy started: ${started.goal.goalId}.` : `Autonomy already running: ${started.goal.goalId}.`;
            await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text, message_thread_id: message.message_thread_id } });
            return;
          }

          if (autonomyController && autonomyDb) {
            const supervisorReply = matchAutonomousTelegramSupervisorReply(autonomyDb, message);
            if (supervisorReply && autonomyController.recordSupervisorInput(supervisorReply)) {
              return;
            }
          }

          if (await handleInteractiveCliCommand({
            rawText,
            botUsername,
            chatKey,
            chatId,
            threadId: message.message_thread_id,
            resolvePreference: resolveCredentialCheckedPreference,
            sendMessage: (body) => sendTelegramMessage({ client, kind: "interactive", chatId, body }),
          })) {
            return;
          }
          if (isSensorsCommand(rawText, botUsername)) {
            await sendTelegramMessage({
              client,
              kind: "interactive",
              chatId,
              body: {
                text: "Sensors",
                reply_markup: buildSensorsKeyboard(sensorRegistry.list()),
                message_thread_id: message.message_thread_id,
              },
            });
            return;
          }
        }

        const cbq = typedUpdate.callback_query;
        if (cbq?.data) {
          if (await handleSensorCallback({
            data: cbq.data,
            chatId: cbq.message?.chat?.id,
            threadId: cbq.message?.message_thread_id,
            runner: sensorRegistry,
            acknowledge: (text) => client.answerCallbackQuery({ callback_query_id: cbq.id, text }).then(() => undefined),
            send: (text, threadId) => {
              const callbackChatId = cbq.message?.chat?.id;
              if (callbackChatId === undefined) return Promise.resolve();
              return sendTelegramMessage({
                client,
                kind: "interactive",
                chatId: callbackChatId,
                body: { text, message_thread_id: threadId },
              }).then(() => undefined);
            },
          })) {
            return;
          }

          const newCli = handleCliSwitchCallback(cbq.data);
          if (newCli !== null) {
            const available = getAvailableCliKinds();
            if (!available.has(newCli)) {
              await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `${newCli} is not available on this box` });
              return;
            }

            const chatId = cbq.message?.chat?.id;
            const messageId = cbq.message?.message_id;
            const chatKey = resolveUpdateChatKey(typedUpdate);
            if (chatKey) {
              switchManualCli(db, { surfaceIdentity: surfaceIdentity, chatKey }, newCli, fallbackChain);
            }
            await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `Switched to ${newCli}` });
            if (chatId && messageId) {
              await client.editMessageText({
                chat_id: chatId,
                message_id: messageId,
                text: buildCliStatusText(newCli, available),
                reply_markup: buildCliKeyboard(newCli, available),
              });
            }
            if (chatKey) {
              await registerGlobalCommands(newCli, " after cli callback");
              if (chatId != null && isGroupInteractiveUpdate(typedUpdate)) {
                await registerGroupChatCommands(newCli, chatId);
              }
            }
            return;
          }
        }

        const chatKey = resolveUpdateChatKey(typedUpdate);
        if (chatKey) {
          const chatId = typedUpdate.message?.chat?.id ?? typedUpdate.callback_query?.message?.chat?.id;
          const threadId = resolveMessageThreadId(typedUpdate);
          const { pref } = resolveCredentialCheckedPreference(chatKey);
          if (!pref) {
            await handleUnavailableCliUpdate(typedUpdate, client, async (unavailableChatId, unavailableThreadId) => {
              await sendTelegramMessage({
                client,
                kind: "interactive",
                chatId: unavailableChatId,
                body: { text: "No CLI is currently available on this box. Authenticate or install a CLI, then run /cli again.", message_thread_id: unavailableThreadId },
              });
            });
            return;
          }

          if (chatId != null) {
            onDeferred(dispatchUnifiedTelegramUpdate(typedUpdate, chatKey, surfaceIdentity, engines[pref], async (turn) => {
              await dispatchInteractiveTurnWithFallback(turn, {
                engines,
                fallbackChain,
                fallbackRequests,
                capacityFallbackAttempts,
                db,
                notify: async (msg) => {
                  await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: msg, message_thread_id: threadId } });
                },
                onCliSwitched: async (newCli) => {
                  await registerGlobalCommands(newCli, " during fallback");
                  if (isGroupInteractiveUpdate(typedUpdate)) {
                    await registerGroupChatCommands(newCli, chatId);
                  }
                },
              });
            }).catch((err: unknown) => { console.error("[interactive] dispatch error", err); throw err; }));
            return;
          } else {
            onDeferred(engines[pref].handleUpdate(typedUpdate, chatKey)
              .catch((err: unknown) => { console.error("[interactive] handleUpdate error", err); throw err; }));
          }
        } else {
          const pref = resolveAvailableCliPreference("codex", getAvailableCliKinds());
          if (pref) {
            await engines[pref].handleUpdate(typedUpdate);
          } else {
            await handleUnavailableCliUpdate(typedUpdate, client, async () => {});
          }
        }
  } catch (err) {
    console.error("[interactive] update handling failed", err);
    throw err;
  }
}

/** A claimed but uncorrelated receipt is unsafe to blindly replay after a crash. */
async function dispatchInteractivePollReceipt(receipt: { id: number; payload_json: string }): Promise<void> {
  if (!db.claimEventReceiptDispatch(receipt.id)) return;
  let handedOff = false;
  const finish = (status: "completed" | "failed", errorClass?: string) => {
    db.finishEventReceipt(receipt.id, {
      status,
      ...(errorClass ? { error_class: errorClass } : {}),
    });
  };
  try {
    const update = JSON.parse(receipt.payload_json) as TelegramUpdate;
    await processAdmittedInteractiveUpdate(update, (operation) => {
      handedOff = true;
      void operation.then(
        () => finish("completed"),
        (error) => {
          console.error("[interactive] deferred Telegram dispatch failed", error);
          finish("failed", "telegram_dispatch_failed");
        },
      );
    });
    if (!handedOff) finish("completed");
  } catch (error) {
    console.error("[interactive] Telegram receipt processing failed", error);
    if (!handedOff) finish("failed", "telegram_processing_failed");
  }
}

// A committed receipt never needs Telegram to redeliver it after restart.
// Re-drive only never-started receipts; do not auto-resubmit a potentially
// running/side-effecting dispatch after uncertain delivery.
for (const receipt of db.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["received"])) {
  await dispatchInteractivePollReceipt(receipt);
}
const uncertainPollReceipts = db.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["dispatching", "run_created"]);
if (uncertainPollReceipts.length > 0) {
  console.warn(`[interactive] ${uncertainPollReceipts.length} interrupted Telegram receipt(s) need authoritative Run/queue reconciliation; refusing duplicate automatic execution`);
}

for (;;) {
  try {
    const updates = await client.getUpdates({ offset: offset + 1, timeout: 30, allowed_updates: ["message", "callback_query"] });

    for (const update of (updates.result as TelegramUpdate[]) ?? []) {
      const updateId = update.update_id;
      if (!isAuthorizedInteractiveUpdate(update, allowedUserIds)) {
        // An unauthorized/no-actor update has no effect to recover; preserving
        // the existing checkpoint and auth boundary is sufficient.
        db.setLastUpdateId(POLL_KIND, updateId);
        offset = updateId;
        await processAdmittedInteractiveUpdate(update, () => undefined);
        continue;
      }
      // The receipt and offset are a single durable transaction. Do not
      // acknowledge Telegram or start a provider unless admission commits.
      const admitted = admitInteractivePolledUpdate(db, POLL_KIND, update);
      offset = updateId;
      if (admitted.created || admitted.receipt.status === "received") {
        // Command/callback work stays sequential. Provider Runs detach via
        // onDeferred as soon as dispatch starts; polling never awaits the Run.
        await dispatchInteractivePollReceipt(admitted.receipt);
      }
    }
  } catch (err) {
    console.error("[interactive] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
}
