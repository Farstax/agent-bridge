/**
 * PURPOSE: Entry point for the unified Telegram runtime.
 * One Telegram bot polls for messages. It is either switchable across providers
 * or fixed to one provider by BRIDGE_PROVIDER_LOCK for dedicated bot units.
 * NEIGHBORS: src/providerLock.ts, src/interactiveBot.ts, src/engine.ts, src/db.ts
 */

import dotenv from "dotenv";
import { join } from "node:path";
import { getBridgeProjectDir } from "./bridge.js";
import { openProductionDb } from "./db.js";
import { TelegramClient } from "./telegram.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { sendTelegramMessage } from "./messageDelivery.js";
import { loadBotsConfig, resolveExecutionMode, resolveBusyMessageMode, validateBusyMessageModeEnv } from "./config.js";
import { ProviderFallbackChain } from "./providerFallback.js";
import { parseCliChain, interactiveChainKinds } from "./providers/selection.js";
import { getAvailableCliKinds } from "./interactiveCliAuth.js";
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
  isCliCommandText,
  describeInteractiveUpdateForLog,
  isGroupInteractiveUpdate,
  dispatchInteractiveWithFallback,
  dispatchClaimedInteractiveWithFallback,
  resolveAvailableCliPreference,
  applyManualCliSwitchHandoff,
  type CliKind,
} from "./interactiveBot.js";
import { resolveAutonomyRuntimeConfig, resolveTelegramRuntimePolicy } from "./providerLock.js";
import { runCli } from "./cli.js";
import { getExecutionProcessState } from "./cliSupervisor.js";
import { resolveTimeoutsForKind } from "./timeouts.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { parseHealthBotMode } from "./health/config.js";
import { createHealthRuntime } from "./health/runtime.js";
import { handleIntegratedHealthCommand } from "./health/integrated.js";
import { autoUpdateClis } from "./health/autoRemediate.js";
import { startOwnerNotificationIngress } from "./ownerNotificationIngress.js";
import { deriveConversationOwnerKey } from "./conversationOwnerKey.js";
import { loadWorkspaceContext } from "./workspaceContext.js";
import { AutonomyController, isFirstClassAutonomyBot } from "./autonomyController.js";
import { matchAutonomousTelegramSupervisorReply, parseAutonomyTelegramCommand } from "./autonomyTelegram.js";
import { AUTONOMOUS_RUN_SURFACE } from "./autonomousGoalRuntime.js";
import {
  ScheduledRoutineRunner,
  buildScheduledInteractiveUpdate,
  scheduledTelegramDestination,
} from "./scheduledRoutines.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.interactive",
  override: false,
});

const supportedCliKinds = interactiveChainKinds();
const configuredCliChain = parseCliChain(
  process.env.INTERACTIVE_CLI_CHAIN,
  { allowed: supportedCliKinds, fallback: ["codex", "claude", "grok", "antigravity", "cursor"] },
);
const runtimePolicy = resolveTelegramRuntimePolicy(process.env, supportedCliKinds);
const { providerLock, token } = runtimePolicy;
if (!token) {
  throw new Error(
    providerLock
      ? `Telegram bot token is required for locked provider ${providerLock}`
      : "TELEGRAM_BOT_TOKEN_INTERACTIVE is required",
  );
}

const allowedUserIds = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS || process.env.TELEGRAM_ALLOWED_USER_ID || "")
    .split(",").map(s => s.trim()).filter(Boolean)
);

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/bridge.sqlite`;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS || 1000);
const executionMode = resolveExecutionMode(providerLock ?? "codex", process.env);
validateBusyMessageModeEnv(process.env);
const busyMessageMode = resolveBusyMessageMode(process.env);
const integratedHealth = !providerLock && parseHealthBotMode(process.env) === "integrated";
const {
  enabled: autonomyEnabled,
  dir: autonomyDir,
  dbPath: autonomyDbPath,
  maxCycles: autonomyMaxCycles,
} = resolveAutonomyRuntimeConfig(process.env, providerLock);

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: providerLock,
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
  serviceId: runtimePolicy.databaseServiceId,
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: runtimePolicy.databaseRole,
});
const advisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });
const client = new TelegramClient(
  token,
  fetch,
  resolveTimeoutsForKind(providerLock ?? "codex").fetchTimeoutMs,
);
const autonomyDb = autonomyDbPath ? openProductionDb(autonomyDbPath, {
  serviceId: "telegram:interactive-autonomy",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "interactive",
}) : null;
const ownerNotificationSocketPath = providerLock
  ? undefined
  : process.env.BRIDGE_OWNER_NOTIFICATION_SOCKET?.trim();
const ownerNotificationIngress = ownerNotificationSocketPath
  ? await startOwnerNotificationIngress({
      socketPath: ownerNotificationSocketPath,
      allowedUserIds,
      client: {
        sendMessage: (chatId, text) => client.sendMessage({ chat_id: chatId, text }),
      },
      recordDeliveredAssistantTurn: (chatKey, text) => {
        const ownerKey = deriveConversationOwnerKey(runtimePolicy.surfaceIdentity, allowedUserIds);
        db.addConvTurn(chatKey, "assistant", text, undefined, {
          surfaceIdentity: runtimePolicy.surfaceIdentity,
          ...(ownerKey ? { ownerKey } : {}),
        });
      },
    })
  : null;
if (ownerNotificationIngress) {
  console.log(`[interactive] owner notification ingress listening on ${ownerNotificationSocketPath}`);
  let stopping = false;
  const stopOwnerNotificationIngress = () => {
    if (stopping) return;
    stopping = true;
    void ownerNotificationIngress.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stopOwnerNotificationIngress);
  process.once("SIGTERM", stopOwnerNotificationIngress);
}
const healthDbPath = process.env.HEALTH_DB_PATH || "/home/content-crawler/runtime/agent-bridge/health/health.sqlite";
const healthDb = integratedHealth ? openProductionDb(healthDbPath, {
  serviceId: "telegram:interactive-health",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "health",
}) : null;
const integratedHealthRuntime = healthDb ? createHealthRuntime({
  bridgeDb: healthDb,
  dbPath: healthDbPath,
  env: process.env,
  chatId: 0,
  sendText: async () => {},
  onReport: (report, sendNotification) => autoUpdateClis(report, {
    upgradeScript: `${process.env.BRIDGE_PROJECT_DIR ?? process.cwd()}/scripts/upgrade.sh`,
    sendNotification,
    bridgeCommit: process.env.AGENT_BRIDGE_COMMIT ?? process.env.BRIDGE_COMMIT ?? process.env.BRIDGE_RELEASE_COMMIT,
  }),
}) : null;

await db.reconcileOrphanedRuns({
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
  providerLock ? runtimePolicy.cliKinds : configuredCliChain,
  db,
);
const exhaustedChats = new Set<string>();

function resolveCredentialCheckedPreference(chatKey: string): { pref: CliKind | null; available: Set<CliKind>; stored: CliKind } {
  const detected = getAvailableCliKinds();
  if (providerLock) {
    const available = new Set<CliKind>(detected.has(providerLock) ? [providerLock] : []);
    return { pref: available.has(providerLock) ? providerLock : null, available, stored: providerLock };
  }

  const stored = getUserCliPreference(db, chatKey);
  const pref = resolveAvailableCliPreference(stored, detected);
  if (pref && pref !== stored) {
    setUserCliPreference(db, chatKey, pref);
    fallbackChain.setActiveCli(chatKey, pref);
  }
  return { pref, available: detected, stored };
}

const engines = Object.fromEntries(
  runtimePolicy.cliKinds.map((kind) => {
    const botConfig = config.bots[kind as BotKind];
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          surfaceIdentity: runtimePolicy.surfaceIdentity,
          botConfig: { ...botConfig, token },
          allowedUserIds,
          executionMode: resolveExecutionMode(kind as BotKind, process.env),
          busyMessageMode,
          pollIntervalMs,
          soulContext,
          fullConfig: config,
          advisorCapabilities: advisorBroker ?? undefined,
          hooks: {
            onCapacityExhausted: async (chatKey: string) => {
              exhaustedChats.add(chatKey);
            },
          },
        },
        db,
        client,
      ),
    ];
  }),
) as Record<CliKind, BridgeEngine>;

const defaultPref = providerLock
  ?? resolveAvailableCliPreference(getUserCliPreference(db, "default"), getAvailableCliKinds())
  ?? "codex";

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
    pollIntervalMs,
    soulContext: autonomySoulContext,
    workingDir: join(autonomyDir, "work"),
    workspaceContext: autonomyWorkspaceContext,
  }, autonomyDb, client)]),
) as Record<CliKind, BridgeEngine> : null;
const autonomyController = autonomyDb && autonomyDir && autonomyEngines ? new AutonomyController({
  db: autonomyDb,
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
  for (const body of buildGlobalInteractiveCommandRegistrations(pref, { integratedHealth, autonomy: autonomyEnabled })) {
    const scopeName = body.scope?.type ?? "default";
    await client.setMyCommands(body)
      .catch((err: unknown) => console.warn(`[interactive] setMyCommands (${scopeName}) failed${label}`, err));
  }
}

async function registerGroupChatCommands(pref: CliKind, chatId: number): Promise<void> {
  for (const body of buildChatInteractiveCommandRegistrations(pref, chatId, { integratedHealth, autonomy: autonomyEnabled })) {
    const scopeName = body.scope?.type ?? "chat";
    await client.setMyCommands(body)
      .catch((err: unknown) => console.warn(`[interactive] setMyCommands (${scopeName} ${chatId}) failed`, err));
  }
}

for (const engine of Object.values(engines)) {
  engine.setQueuedMessageHandler(async (queued) => {
    const chatKey = queued.chatKey;
    return dispatchClaimedInteractiveWithFallback(queued, chatKey, {
      engines, fallbackChain, exhaustedChats, db,
      notify: async (msg) => {
        await sendTelegramMessage({ client, kind: "interactive", chatId: queued.chatId, body: { text: msg, message_thread_id: queued.threadId ?? undefined } });
      },
      onCliSwitched: async (newCli) => {
        await registerGlobalCommands(newCli, " during queued fallback");
        if (queued.chatType === "group" || queued.chatType === "supergroup") await registerGroupChatCommands(newCli, queued.chatId);
      },
    });
  });
}

await engines[defaultPref].recoverPendingQueues();

const scheduledOwnerKey = deriveConversationOwnerKey(runtimePolicy.surfaceIdentity, allowedUserIds);
const scheduledActorId = allowedUserIds.values().next().value;
const scheduledRoutineRunner = scheduledOwnerKey && scheduledActorId ? new ScheduledRoutineRunner(
  db,
  runtimePolicy.surfaceIdentity,
  async (routine, intendedAt) => {
    if (routine.ownerKey !== scheduledOwnerKey) {
      console.warn(`[scheduled-routines] owner mismatch for ${routine.id}; occurrence skipped`);
      return;
    }
    const destination = scheduledTelegramDestination(routine);
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

    const update = buildScheduledInteractiveUpdate(routine, intendedAt, scheduledActorId);
    await dispatchInteractiveWithFallback(update, routine.chatKey, {
      engines,
      fallbackChain,
      exhaustedChats,
      db,
      notify: sendNotice,
      onCliSwitched: async (newCli) => {
        await registerGlobalCommands(newCli, " during scheduled fallback");
        if (destination.chatId < 0) await registerGroupChatCommands(newCli, destination.chatId);
      },
    });
  },
) : null;
scheduledRoutineRunner?.start();

await registerGlobalCommands(defaultPref, "");
const registeredGroupChats = new Set<number>();

console.log(`[interactive] starting polling${providerLock ? ` locked to ${providerLock}` : ""}...`);

let offset = db.getLastUpdateId(runtimePolicy.pollKind);
const POLL_KIND = runtimePolicy.pollKind;

for (;;) {
  try {
    const updates = await client.getUpdates({ offset: offset + 1, timeout: 30, allowed_updates: ["message", "callback_query"] });

    for (const update of (updates.result as any) ?? []) {
      const updateId: number = update.update_id;
      offset = updateId;
      db.setLastUpdateId(POLL_KIND, updateId);

      try {
        const typedUpdate = update as TelegramUpdate;
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
          continue;
        }

        const message = typedUpdate.message;
        if (message) {
          const rawText = (message.text || "").trim();
          const chatId = message.chat.id;
          const chatKey = resolveUpdateChatKey(typedUpdate) ?? String(chatId);

          const autonomyCommand = parseAutonomyTelegramCommand(rawText, botUsername);
          if (autonomyCommand) {
            if (!autonomyController) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "Autonomy is not configured on this runtime.", message_thread_id: message.message_thread_id } });
              continue;
            }
            if (autonomyCommand === "status") {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              continue;
            }
            if (autonomyCommand === "stop") {
              await autonomyController.stop("authenticated owner /autonomy stop");
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: autonomyController.statusText(), message_thread_id: message.message_thread_id } });
              continue;
            }
            const { pref } = resolveCredentialCheckedPreference(chatKey);
            if (!pref) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: { text: "No authenticated CLI is available to start autonomy.", message_thread_id: message.message_thread_id } });
              continue;
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
              continue;
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
            continue;
          }

          if (autonomyController && autonomyDb) {
            const supervisorReply = matchAutonomousTelegramSupervisorReply(autonomyDb, message);
            if (supervisorReply && autonomyController.recordSupervisorInput(supervisorReply)) {
              continue;
            }
          }

          if (isCliCommandText(rawText, botUsername)) {
            if (providerLock) {
              await sendTelegramMessage({ client, kind: "interactive", chatId, body: {
                text: `Provider is fixed to **${providerLock}** for this bot.`,
                message_thread_id: message.message_thread_id,
              } });
              continue;
            }
            const { pref, available, stored } = resolveCredentialCheckedPreference(chatKey);
            await sendTelegramMessage({ client, kind: "interactive", chatId, body: {
              text: buildCliStatusText(pref ?? stored, available),
              reply_markup: buildCliKeyboard(pref ?? stored, available),
              message_thread_id: message.message_thread_id,
            } });
            continue;
          }
          if (integratedHealthRuntime && await handleIntegratedHealthCommand({
            rawText,
            botUsername,
            chatId,
            runCheck: () => integratedHealthRuntime.runChecks(async (text) => {
              await sendTelegramMessage({
                client,
                kind: "interactive",
                chatId,
                body: { text, message_thread_id: message.message_thread_id },
              });
            }),
            getStatus: () => integratedHealthRuntime.statusText(),
            sendText: async (text) => {
              await sendTelegramMessage({
                client,
                kind: "interactive",
                chatId,
                body: { text, message_thread_id: message.message_thread_id },
              });
            },
          })) {
            continue;
          }
        }

        const cbq = typedUpdate.callback_query;
        if (cbq?.data) {
          const newCli = handleCliSwitchCallback(cbq.data);
          if (newCli !== null) {
            if (providerLock) {
              await client.answerCallbackQuery({
                callback_query_id: cbq.id,
                text: `Provider is fixed to ${providerLock}`,
              });
              continue;
            }
            const available = getAvailableCliKinds();
            if (!available.has(newCli)) {
              await client.answerCallbackQuery({ callback_query_id: cbq.id, text: `${newCli} is not available on this box` });
              continue;
            }

            const chatId = cbq.message?.chat?.id;
            const messageId = cbq.message?.message_id;
            const chatKey = resolveUpdateChatKey(typedUpdate);
            if (chatKey) {
              applyManualCliSwitchHandoff(db, chatKey, newCli);
              fallbackChain.setActiveCli(chatKey, newCli);
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
            continue;
          }
        }

        const chatKey = resolveUpdateChatKey(typedUpdate);
        if (chatKey) {
          const chatId = typedUpdate.message?.chat?.id ?? typedUpdate.callback_query?.message?.chat?.id;
          const threadId = resolveMessageThreadId(typedUpdate);
          const { pref } = resolveCredentialCheckedPreference(chatKey);
          if (!pref) {
            if (chatId != null) {
              await sendTelegramMessage({
                client,
                kind: "interactive",
                chatId,
                body: { text: "No CLI is currently available on this box. Authenticate or install a CLI, then run /cli again.", message_thread_id: threadId },
              });
            }
            continue;
          }

          if (chatId != null) {
            dispatchInteractiveWithFallback(typedUpdate, chatKey, {
              engines,
              fallbackChain,
              exhaustedChats,
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
            }).catch((err: unknown) => console.error("[interactive] dispatch error", err));
          } else {
            engines[pref].handleUpdate(typedUpdate)
              .catch((err: unknown) => console.error("[interactive] handleUpdate error", err));
          }
        } else {
          const pref = providerLock
            ? (getAvailableCliKinds().has(providerLock) ? providerLock : null)
            : resolveAvailableCliPreference("codex", getAvailableCliKinds());
          if (pref) {
            await engines[pref].handleUpdate(typedUpdate);
          }
        }
      } catch (err) {
        console.error("[interactive] update handling failed", err);
      }
    }
  } catch (err) {
    console.error("[interactive] poll error", err);
    await new Promise(r => setTimeout(r, 5000));
  }
}
