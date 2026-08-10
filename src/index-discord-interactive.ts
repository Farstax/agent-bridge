/**
 * PURPOSE: Interactive Discord bot — a single bot that routes messages to the
 * user's preferred CLI (codex | claude | antigravity) per channel, with
 * one-tap switching via Discord button components.
 *
 * Mirrors src/index-interactive.ts for Telegram, adapted for Discord's
 * push-based WebSocket transport and component interaction model.
 *
 * Environment variables (see .env.discord-interactive.example):
 *   DISCORD_BOT_TOKEN            — required
 *   DISCORD_APPLICATION_ID       — required
 *   DISCORD_GUILD_ID             — optional; instant slash command propagation
 *   DISCORD_ALLOWED_USER_IDS     — comma-separated Discord snowflake user IDs
 *   INTERACTIVE_CLI_CHAIN        — comma-separated fallback order (default: codex,claude,antigravity)
 *   CODEX_COMMAND / CLAUDE_COMMAND / ANTIGRAVITY_COMMAND — CLI binary paths
 *   DB_PATH                      — SQLite for session/lock/CLI-preference state
 *   BRIDGE_EXECUTION_MODE        — "safe" | "trusted"
 *   BRIDGE_ASYNC_ENABLED         — "true" | "false"
 */

import dotenv from "dotenv";
import { getBridgeProjectDir } from "./bridge.js";
import { openProductionDb } from "./db.js";
import { getExecutionProcessState, shutdownCliProcesses } from "./cliSupervisor.js";
import { loadBotsConfig, resolveBusyMessageMode, validateBusyMessageModeEnv } from "./config.js";
import { DiscordClient, type DiscordUpdate } from "./discord.js";
import { BridgeEngine } from "./engine.js";
import { defaultSoulPath, loadSoulContext, normalizeSoulMode } from "./soul.js";
import { WorkerFallbackChain } from "./workerFallback.js";
import type { MessagingPlatform } from "./platform.js";
import {
  getUserCliPreference,
  setUserCliPreference,
  buildCliStatusText,
  handleCliSwitchCallback,
  dispatchInteractiveWithFallback,
  dispatchClaimedInteractiveWithFallback,
  clearInteractiveFallbackState,
  applyManualCliSwitchHandoff,
  type CliKind,
} from "./interactiveBot.js";
import { runCli } from "./cli.js";
import { parseCompactionProviderChain, runCapacityFallbackCompaction } from "./fallbackCompaction.js";
import type { BridgeConfig, BotKind, TelegramUpdate, TelegramMessage } from "./types.js";
import { startConfiguredAdvisorBroker } from "./advisorBroker.js";
import { busyMessageModeSettingKey, resolveLaneBusyMessageMode, type BusyMessageMode } from "./busyMessageMode.js";
import { discordLaneKey } from "./discordLaneKey.js";

dotenv.config({
  path: process.env.BRIDGE_ENV_FILE || ".env.discord-interactive",
  override: false,
});


// ── Config ───────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN is required");

const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!applicationId) throw new Error("DISCORD_APPLICATION_ID is required");

const allowedUserIds = new Set(
  (process.env.DISCORD_ALLOWED_USER_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
);
const engineAllowedUserIds = new Set<string>(allowedUserIds);
for (const id of allowedUserIds) {
  engineAllowedUserIds.add(String(numericId(id)));
}

const dbPath = process.env.DB_PATH || `${getBridgeProjectDir()}/.data/discord-interactive.sqlite`;
const executionMode = (process.env.BRIDGE_EXECUTION_MODE as "safe" | "trusted") || "safe";
validateBusyMessageModeEnv(process.env);
const busyMessageMode = resolveBusyMessageMode(process.env);
const asyncEnabled = process.env.BRIDGE_ASYNC_ENABLED !== "false";

const config: BridgeConfig = {
  allowedUserIds: engineAllowedUserIds,
  serviceEnvFile: null,
  serviceKind: null,
  pollIntervalMs: 1_000,
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
if (soulContext) console.log(`[discord-interactive] loaded SOUL.md context (${soulContext.length} chars)`);

const db = openProductionDb(dbPath, {
  serviceId: "discord:interactive",
  installationId: process.env.AGENT_BRIDGE_INSTALLATION_ID,
  requireInstallationIdentity: process.env.NODE_ENV === "production" && Boolean(process.env.AGENT_BRIDGE_INSTALLATION_ID?.trim()),
  databaseRole: "discord",
});
const advisorBroker = await startConfiguredAdvisorBroker({ db, bots: config.bots, runCli });

// ── Fallback chain ────────────────────────────────────────────────────────────

const cliChain = (process.env.INTERACTIVE_CLI_CHAIN || "codex,claude,antigravity")
  .split(",").map((s) => s.trim()).filter(Boolean);
const fallbackChain = new WorkerFallbackChain(cliChain, db);
const compactionProviderChain = parseCompactionProviderChain(process.env.BRIDGE_COMPACTION_CHAIN);
const exhaustedChats = new Set<string>();
const snowflakeAliases = new Map<string, string>();

class DiscordEngineClient implements MessagingPlatform {
  constructor(
    private readonly inner: DiscordClient,
    private readonly aliases: Map<string, string>,
  ) {}

  getUpdates(): Promise<any> {
    throw new Error("Discord gateway is push-based; getUpdates is not supported");
  }

  sendMessage(body: any): Promise<any> {
    return this.inner.sendMessage(this.rewriteBody(body));
  }

  editMessageText(body: any): Promise<any> {
    return this.inner.editMessageText(this.rewriteBody(body));
  }

  sendChatAction(body: any): Promise<any> {
    return this.inner.sendChatAction(this.rewriteBody(body));
  }

  answerCallbackQuery(body: any): Promise<any> {
    return this.inner.answerCallbackQuery(body);
  }

  setMyCommands(body: any): Promise<any> {
    return this.inner.setMyCommands(body);
  }

  sendDocument(chatId: number, filePath: string, caption?: string, options?: unknown): Promise<void> {
    return this.inner.sendDocument(this.resolveSnowflake(chatId), filePath, caption);
  }

  sendPhoto(chatId: number, filePath: string, caption?: string, options?: unknown): Promise<void> {
    return this.inner.sendPhoto(this.resolveSnowflake(chatId), filePath, caption);
  }

  getFilePath(fileId: string): Promise<string> {
    return this.inner.getFilePath(fileId);
  }

  downloadFile(filePath: string, destPath: string): Promise<void> {
    return this.inner.downloadFile(filePath, destPath);
  }

  private rewriteBody(body: any): any {
    const chatId = body?.chat_id ?? body?.channel_id;
    if (chatId == null) return body;
    const snowflake = this.resolveSnowflake(chatId);
    return { ...body, chat_id: snowflake, channel_id: snowflake };
  }

  private resolveSnowflake(id: number | string): string {
    return this.aliases.get(String(id)) ?? String(id);
  }
}

// ── DiscordClient ─────────────────────────────────────────────────────────────

let reconciliationReady: Promise<void> = new Promise(() => {});
const client = new DiscordClient({
  token,
  applicationId,
  guildId: process.env.DISCORD_GUILD_ID,
  onUpdate: (update: DiscordUpdate) => {
    reconciliationReady
      .then(() => handleDiscordUpdate(update))
      .catch((err) => console.error("[discord-interactive] update blocked during startup recovery", err));
  },
  onReady: () => {
    console.log("[discord-interactive] gateway ready");
    registerCommands().catch((err) =>
      console.warn("[discord-interactive] command registration failed", err),
    );
    reconciliationReady = db.reconcileOrphanedRuns({
      minAgeMs: Number(process.env.ORPHAN_RECONCILIATION_MIN_AGE_MS || 10 * 60 * 1000),
      processState: (run) => getExecutionProcessState(run.run_id),
      containmentState: (_run, processState) => processState === "absent" ? "proven" : "ambiguous",
      onReconciled: async (run) => {
        await client.sendMessage({
          chat_id: run.chat_id,
          text: "⚠️ **Agent bridge restarted.** The active task was interrupted. You can reply with `provide update` or `continue` to resume.",
        }).catch((err) => console.error(`Failed to send restart notification to Discord channel ${run.chat_id}`, err));
      },
     }).then(() => undefined).catch((err) => {
       console.error("[discord-interactive] orphan reconciliation failed", err);
       throw err;
     });
  },
  onError: (err) => console.error("[discord-interactive] gateway error", err),
});
const engineClient = new DiscordEngineClient(client, snowflakeAliases);

// ── Engines ───────────────────────────────────────────────────────────────────

const CLI_KINDS: CliKind[] = ["codex", "claude", "antigravity"];
const engines = Object.fromEntries(
  CLI_KINDS.map((kind) => [
    kind,
    new BridgeEngine(
      {
        kind,
        surfaceIdentity: "discord:interactive",
        botConfig: { ...config.bots[kind as BotKind], token },
        allowedUserIds: engineAllowedUserIds,
        executionMode,
        busyMessageMode,
        asyncEnabled,
        pollIntervalMs: 1_000,
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
      engineClient,
    ),
  ]),
) as Record<CliKind, BridgeEngine>;

for (const engine of Object.values(engines)) {
  engine.setQueuedMessageHandler(async (queued) => {
    return dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {
      engines, fallbackChain, exhaustedChats, db,
      notify: async (msg) => { await engineClient.sendMessage({ chat_id: queued.chatId, text: msg }); },
      onCliSwitched: async (newCli) => setUserCliPreference(db, queued.chatKey, newCli),
      compactBeforeSwitch: (request) => runCapacityFallbackCompaction(request, {
        db, runCli, bots: config.bots, configuredChain: compactionProviderChain, compactProfile: "companion",
      }),
    });
  });
}

await engines.codex.recoverPendingQueues();

// ── Slash command registration ────────────────────────────────────────────────

async function registerCommands(): Promise<void> {
  await client.setMyCommands({
    commands: buildDiscordInteractiveCommands(),
  });
}

function buildDiscordInteractiveCommands() {
  return [
    {
      name: "cli",
      description: "Show the active CLI or switch to another",
      type: 1,
      options: [{
        name: "to",
        description: "CLI to switch to",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "codex", value: "codex" },
          { name: "claude", value: "claude" },
          { name: "antigravity", value: "antigravity" },
        ],
      }],
    },
    { name: "reset",  description: "Reset session and clear pending work", type: 1 },
    { name: "models", description: "Show available models",            type: 1 },
    { name: "stop",   description: "Abort the running CLI execution",  type: 1 },
    { name: "queue_mode", description: "Set busy-message handling", type: 1 },
  ];
}

// ── Button components ─────────────────────────────────────────────────────────

function buildCliComponents(activeCli: CliKind) {
  return [{
    type: 1, // ACTION_ROW
    components: CLI_KINDS.map((cli) => ({
      type: 2, // BUTTON
      label: cli === activeCli ? `✓ ${cli}` : cli,
      style: cli === activeCli ? 1 : 2, // 1=PRIMARY (blue), 2=SECONDARY (grey)
      custom_id: `cli:${cli}`,
      disabled: cli === activeCli,
    })),
  }];
}

function queueModeText(mode: BusyMessageMode): string {
  return `Busy-message mode: ${mode}. This applies to new messages while this lane is busy.`;
}

function buildQueueModeComponents(active: BusyMessageMode) {
  const modes: BusyMessageMode[] = ["augment", "interrupt", "queue"];
  return [{
    type: 1,
    components: modes.map((mode) => ({ type: 2, style: 2, label: mode === active ? `✓ ${mode}` : mode, custom_id: `queue_mode:${mode}` })),
  }, {
    type: 1,
    components: [{ type: 2, style: 2, label: "Use configured default", custom_id: "queue_mode:reset" }],
  }];
}

// ── Update router ─────────────────────────────────────────────────────────────

async function handleDiscordUpdate(update: DiscordUpdate): Promise<void> {
  if (update.type === "MESSAGE_CREATE") {
    await handleMessage(update.data);
    return;
  }
  if (update.type === "INTERACTION_CREATE") {
    await handleInteraction(update.data);
    return;
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

function describeDiscordMessageForLog(d: any, reason?: string) {
  const content = String(d.content ?? "").trim();
  return {
    id: d.id ? String(d.id) : undefined,
    channelId: d.channel_id ? String(d.channel_id) : undefined,
    guildId: d.guild_id ? String(d.guild_id) : undefined,
    authorId: d.author?.id ? String(d.author.id) : undefined,
    authorBot: Boolean(d.author?.bot),
    content: content ? "text" : "empty",
    contentLength: content.length,
    reason,
  };
}

async function handleMessage(d: any): Promise<void> {
  const authorId = String(d.author?.id ?? "");
  if (!allowedUserIds.has(authorId)) {
    console.log("[discord-interactive] update.ignored", JSON.stringify(describeDiscordMessageForLog(d, "unauthorized_author")));
    return;
  }
  if (d.author?.bot) {
    console.log("[discord-interactive] update.ignored", JSON.stringify(describeDiscordMessageForLog(d, "bot_author")));
    return;
  }

  const content = String(d.content ?? "").trim();
  if (!content) {
    console.log("[discord-interactive] update.ignored", JSON.stringify(describeDiscordMessageForLog(d, "empty_content")));
    return;
  }
  console.log("[discord-interactive] update.received", JSON.stringify(describeDiscordMessageForLog(d)));

  const channelId = String(d.channel_id ?? "");
  const chatKey = channelId; // Discord: channel IS the conversation unit

  const chatId = rememberSnowflakeAlias(channelId);
  const userId = rememberSnowflakeAlias(authorId);

  const update: TelegramUpdate = {
    update_id: numericId(d.id ?? "0"),
    message: {
      message_id: numericId(d.id ?? "0"),
      chat: { id: chatId, type: d.guild_id ? "supergroup" : "private" },
      from: { id: userId, first_name: d.author?.username ?? "User" },
      text: content,
    } satisfies TelegramMessage,
  };

  await dispatchInteractiveWithFallback(update, chatKey, {
    engines,
    fallbackChain,
    exhaustedChats,
    db,
    notify: async (msg) => {
      await client.sendMessage({ chat_id: channelId, text: msg });
    },
    onCliSwitched: async (_newCli) => {
      // Slash command list doesn't change per-CLI on Discord — no-op
    },
    compactBeforeSwitch: (request) =>
      runCapacityFallbackCompaction(request, {
        db,
        runCli,
        bots: config.bots,
        configuredChain: compactionProviderChain,
        compactProfile: "companion",
      }),
  });
}

// ── Interaction handler ───────────────────────────────────────────────────────

async function handleInteraction(d: any): Promise<void> {
  const interactionType = d.type as number; // 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT

  // ── Button click (CLI switch) ─────────────────────────────────────────────
  if (interactionType === 3) {
    const customId = String(d.data?.custom_id ?? "");
    const userId = String(d.member?.user?.id ?? d.user?.id ?? "");
    if (!allowedUserIds.has(userId)) return;
    const channelId = String(d.channel_id ?? "");
    if (customId.startsWith("queue_mode:")) {
      const value = customId.slice("queue_mode:".length);
      if (!["augment", "interrupt", "queue", "reset"].includes(value)) return;
      const laneKey = discordLaneKey(channelId);
      db.setSetting(busyMessageModeSettingKey("discord:interactive", laneKey), value === "reset" ? null : value);
      const effective = resolveLaneBusyMessageMode(db, "discord:interactive", laneKey, busyMessageMode);
      await client.answerCallbackQuery({ interaction_id: d.id, interaction_token: d.token, type: 7,
        data: { content: queueModeText(effective), components: buildQueueModeComponents(effective) } });
      return;
    }
    const newCli = handleCliSwitchCallback(customId);
    if (!newCli) return;
    applyManualCliSwitchHandoff(db, channelId, newCli);
    fallbackChain.setActiveCli(channelId, newCli);

    // UPDATE_MESSAGE (type 7) — edit the /cli message in-place
    await client.answerCallbackQuery({
      interaction_id: d.id,
      interaction_token: d.token,
      type: 7,
      data: {
        content: buildCliStatusText(newCli),
        components: buildCliComponents(newCli),
      },
    }).catch((err) => console.warn("[discord-interactive] button ACK failed", err));
    return;
  }

  // ── Slash command ─────────────────────────────────────────────────────────
  if (interactionType === 2) {
    const commandName = String(d.data?.name ?? "");
    const userId = String(d.member?.user?.id ?? d.user?.id ?? "");
    if (!allowedUserIds.has(userId)) return;

    const channelId = String(d.channel_id ?? "");

    if (commandName === "queue_mode") {
      const effective = resolveLaneBusyMessageMode(db, "discord:interactive", discordLaneKey(channelId), busyMessageMode);
      await client.answerCallbackQuery({ interaction_id: d.id, interaction_token: d.token, type: 4,
        data: { content: queueModeText(effective), components: buildQueueModeComponents(effective) } });
      return;
    }

    if (commandName === "cli") {
      const toOption = d.data?.options?.find((o: any) => o.name === "to")?.value as string | undefined;
      if (toOption) {
        const newCli = handleCliSwitchCallback(`cli:${toOption}`);
        if (newCli) {
          applyManualCliSwitchHandoff(db, channelId, newCli);
          fallbackChain.setActiveCli(channelId, newCli);
        }
      }
      const pref = getUserCliPreference(db, channelId);
      // CHANNEL_MESSAGE_WITH_SOURCE (type 4)
      await client.answerCallbackQuery({
        interaction_id: d.id,
        interaction_token: d.token,
        type: 4,
        data: {
          content: buildCliStatusText(pref),
          components: buildCliComponents(pref),
        },
      }).catch((err) => console.warn("[discord-interactive] /cli ACK failed", err));
      return;
    }

    // Other commands → forward to the active CLI engine as a TelegramUpdate
    // ACK immediately with deferred response (3-second window)
    await client.answerCallbackQuery({
      interaction_id: d.id,
      interaction_token: d.token,
      type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
    }).catch((err) => console.warn("[discord-interactive] slash ACK failed", err));

    const promptText = d.data?.options?.[0]?.value as string | undefined ?? commandName;
    const chatId = rememberSnowflakeAlias(channelId);
    const numUserId = rememberSnowflakeAlias(userId);
    const chatKey = channelId;

    const update: TelegramUpdate = {
      update_id: numericId(d.id ?? "0"),
      message: {
        message_id: numericId(d.id ?? "0"),
        chat: { id: chatId, type: d.guild_id ? "supergroup" : "private" },
        from: { id: numUserId, first_name: d.member?.user?.username ?? d.user?.username ?? "User" },
        text: `/${promptText}`,
      } satisfies TelegramMessage,
    };

    if (commandName === "reset") clearInteractiveFallbackState(fallbackChain, chatKey);
    await engines[getUserCliPreference(db, chatKey)].handleUpdate(update);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`[discord-interactive] ${signal} received, shutting down...`);
  client.destroy();
  shutdownCliProcesses();
  await advisorBroker?.close();
  db.close();
  process.exit(0);
};

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

console.log("[discord-interactive] connecting gateway...");
client.connect();

await new Promise(() => {}); // keep process alive — gateway drives everything

// ── Utilities ─────────────────────────────────────────────────────────────────

function rememberSnowflakeAlias(snowflake: string): number {
  const alias = numericId(snowflake);
  snowflakeAliases.set(String(alias), snowflake);
  return alias;
}

function numericId(snowflake: string): number {
  return Number(discordLaneKey(snowflake));
}
