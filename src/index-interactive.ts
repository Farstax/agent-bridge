/**
 * PURPOSE: Entry point for the unified interactive bot.
 * One Telegram bot polls for messages; each message is routed to the user's
 * preferred CLI engine (codex | claude | antigravity). /cli shows the active
 * CLI and an inline keyboard for one-tap switching.
 * NEIGHBORS: src/interactiveBot.ts, src/engine.ts, src/bridge.ts, src/db.ts
 */

import dotenv from "dotenv";
import {
  getBridgeProjectDir,
} from "./bridge.js";
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
import { runCli } from "./cli.js";
import { getExecutionProcessState } from "./cliSupervisor.js";
import { parseCompactionProviderChain, runCapacityFallbackCompaction } from "./fallbackCompaction.js";
import type { BridgeConfig, BotKind, TelegramUpdate } from "./types.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { parseHealthBotMode } from "./health/config.js";
import { createHealthRuntime } from "./health/runtime.js";
import { handleIntegratedHealthCommand } from "./health/integrated.js";
import { recoverCancelledContinuationContainment } from "./continuationRecovery.js";
import { ContinuationRepository } from "./repositories/continuationRepository.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.interactive",
  override: false,
});


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
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";
const integratedHealth = parseHealthBotMode(process.env) === "integrated";

const config: BridgeConfig = {
  allowedUserIds,
  serviceEnvFile: process.env.BRIDGE_ENV_FILE || null,
  serviceKind: null,
  pollIntervalMs,
  executionMode,
  busyMessageMode,
  asyncEnabled,
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
const advisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });
const continuationStore = new ContinuationRepository(db.raw);
const client = new TelegramClient(token, fetch, 45_000);
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
}) : null;

await recoverCancelledContinuationContainment(db, continuationStore);
await db.reconcileOrphanedRuns({
  minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 10 * 60 * 1000),
  // Durable continuation records own restart reconciliation. Keep their runs
  // out of generic orphan cleanup until the provider-specific engine has
  // safely resumed or terminally fenced the continuation.
  processState: (run) => continuationStore.hasActiveRun(run.run_id) ? "live" : getExecutionProcessState(run.run_id),
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

// Fallback chain state. Unknown chain entries are dropped by the shared
// parser; an all-invalid chain falls back to the full default order.
const cliChain = parseCliChain(
  process.env.INTERACTIVE_CLI_CHAIN,
  { allowed: interactiveChainKinds(), fallback: ["codex", "claude", "antigravity"] },
);
const fallbackChain = new ProviderFallbackChain(cliChain, db);
const compactionProviderChain = parseCompactionProviderChain(process.env.BRIDGE_COMPACTION_CHAIN);
const exhaustedChats = new Set<string>();

function resolveCredentialCheckedPreference(chatKey: string): { pref: CliKind | null; available: Set<CliKind>; stored: CliKind } {
  const available = getAvailableCliKinds();
  const stored = getUserCliPreference(db, chatKey);
  const pref = resolveAvailableCliPreference(stored, available);
  if (pref && pref !== stored) {
    setUserCliPreference(db, chatKey, pref);
    fallbackChain.setActiveCli(chatKey, pref);
  }
  return { pref, available, stored };
}

// Build one engine per CLI kind — none polls; we dispatch handleUpdate manually.
const CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const engines = Object.fromEntries(
  CLI_KINDS.map((kind) => {
    const botConfig = config.bots[kind as BotKind];
    return [
      kind,
      new BridgeEngine(
        {
          kind,
          surfaceIdentity: "telegram:interactive",
          botConfig: { ...botConfig, token },
          allowedUserIds,
          executionMode: resolveExecutionMode(kind as BotKind, process.env),
          busyMessageMode,
          asyncEnabled,
          pollIntervalMs,
          soulContext,
          fullConfig: config,
          compactProfile: "companion",
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

const defaultPref = resolveAvailableCliPreference(getUserCliPreference(db, "default"), getAvailableCliKinds()) ?? "codex";
async function registerGlobalCommands(pref: CliKind, label: string): Promise<void> {
  for (const body of buildGlobalInteractiveCommandRegistrations(pref, { integratedHealth })) {
    const scopeName = body.scope?.type ?? "default";
    await client.setMyCommands(body)
      .catch((err: unknown) => console.warn(`[interactive] setMyCommands (${scopeName}) failed${label}`, err));
  }
}

async function registerGroupChatCommands(pref: CliKind, chatId: number): Promise<void> {
  for (const body of buildChatInteractiveCommandRegistrations(pref, chatId, { integratedHealth })) {
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
      compactBeforeSwitch: (request) => runCapacityFallbackCompaction(request, {
        db, runCli, bots: config.bots, configuredChain: compactionProviderChain, compactProfile: "companion",
      }),
    });
  });
}

// The interactive process owns one shared delivery surface but provider
// continuations are provider-specific, so recover each provider's durable
// records before allowing generic queue recovery or starting Telegram polling.
await Promise.all(Object.values(engines).map((engine) => engine.recoverContinuations()));
await engines[defaultPref].recoverPendingQueues();

await registerGlobalCommands(defaultPref, "");
// Tracks which group chat IDs have had per-chat commands registered this session.
// Telegram requires a chat-specific scope registration for commands to appear reliably
// in individual groups, even when global scope alone is not always picked up.
const registeredGroupChats = new Set<number>();

console.log("[interactive] starting polling...");

let offset = db.getLastUpdateId("codex");
const POLL_KIND = "codex" as const;

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
          registerGroupChatCommands(groupPref ?? "codex", groupChatId);
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

          if (isCliCommandText(rawText, botUsername)) {
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
            runCheck: () => integratedHealthRuntime.runChecks(),
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
              compactBeforeSwitch: (request) =>
                runCapacityFallbackCompaction(request, {
                  db,
                  runCli,
                  bots: config.bots,
                  configuredChain: compactionProviderChain,
                  compactProfile: "companion",
                }),
            }).catch((err: unknown) => console.error("[interactive] dispatch error", err));
          } else {
            engines[pref].handleUpdate(typedUpdate)
              .catch((err: unknown) => console.error("[interactive] handleUpdate error", err));
          }
        } else {
          const pref = resolveAvailableCliPreference("codex", getAvailableCliKinds());
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
