/**
 * PURPOSE: Common helper and layout generation functions for Telegram interaction.
 * INPUTS: DB client, configuration settings, and messages context.
 * OUTPUTS: Working directories, layouts, message formatting and parsed targets.
 * NEIGHBORS: src/index.ts, src/cli.ts, src/db.ts
 * LOGIC: Provides interface checks, text extraction helpers, inline keyboard markup setups, and path resolves.
 */

import type { TelegramMessage, BridgeConfig } from "./types.js";
import {
  runCli, runCliAsync, parseCliResult, buildCliInvocation, buildExecutionOptions,
  isCapacityExhaustedError, getNextFallbackModel, toUserMessage, scrubOutputDir,
} from "./cli.js";
import { abortCliProcess, abortCliProcessAndWait, shutdownCliProcesses } from "./cliSupervisor.js";
import { validateBridgeConfig, parseModelPreference } from "./config.js";
import { BridgeDb } from "./db.js";
import { ACP_PROVIDER_DEFAULT, getAcpSessionConfigOption, isAcpSessionConfigValueStale } from "./acp/sessionConfig.js";
import {
  resolveAntigravityConversationId, extractAntigravityConversationId,
  readAntigravityLastConversation, readLatestAntigravityConversationFromLogs,
  setAntigravityModel, ensureAntigravityStateDirs, toAntigravityModelLabel,
} from "./providers/antigravityRuntime.js";
import { isCursorRouteable } from "./providers/cursorAvailability.js";
import { isGrokRouteable } from "./providers/grokAvailability.js";
import { normalizeCliArgs } from "./cliArgNormalization.js";
import { classifyAnyProviderError, classifyProviderError, isFallbackEligibleProviderError } from "./providers/errorClassification.js";

export function getBridgeProjectDir(): string {
  return process.env.BRIDGE_PROJECT_DIR || process.cwd();
}

export function getCliWorkingDir(bot?: "codex" | "antigravity" | "claude" | "grok" | "cursor"): string {
  if (bot === "grok" && !isGrokRouteable()) {
    throw new Error("Grok Build is unavailable: authenticate it or resolve its current qualification failure");
  }
  if (bot === "cursor" && !isCursorRouteable()) {
    throw new Error("Cursor is unavailable: authenticate it or resolve its current qualification failure");
  }
  if (bot === "codex" && process.env.CODEX_PROJECT_DIR) return process.env.CODEX_PROJECT_DIR;
  if (bot === "antigravity" && (process.env.ANTIGRAVITY_PROJECT_DIR || process.env.GEMINI_PROJECT_DIR)) {
    return process.env.ANTIGRAVITY_PROJECT_DIR || process.env.GEMINI_PROJECT_DIR!;
  }
  if (bot === "claude" && process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (bot === "grok" && process.env.GROK_PROJECT_DIR) return process.env.GROK_PROJECT_DIR;
  if (bot === "cursor" && process.env.CURSOR_PROJECT_DIR) return process.env.CURSOR_PROJECT_DIR;
  return process.env.BRIDGE_PROJECT_DIR || process.env.BRIDGE_ROOT_DIR || process.cwd();
}

export function isAuthorizedMessage(message: TelegramMessage, allowedUserIds: ReadonlySet<string>): boolean {
  return allowedUserIds.has(String(message?.from?.id ?? ""));
}

export function extractThreadId(messages: TelegramMessage[]): number | undefined {
  return messages[0]?.message_thread_id;
}

export function extractPromptText(message: TelegramMessage): string | null {
  const text = (message?.text || message?.caption || "").trim();
  if (!text) return null;
  if (text.startsWith("/")) return null;
  return text;
}

function isAcpConfigKind(kind: string): boolean {
  return kind === "codex" || kind === "claude";
}

export function buildModelKeyboard(kind: string, modelPreference: string[], currentModel?: string | null): any {
  if (isAcpConfigKind(kind)) {
    const option = getAcpSessionConfigOption(kind, "model");
    const currentIsAdvertised = Boolean(
      currentModel
      && currentModel !== ACP_PROVIDER_DEFAULT
      && option?.options?.some((candidate) => candidate.value === currentModel)
      && !isAcpSessionConfigValueStale(kind, "model", currentModel),
    );
    const selected = currentIsAdvertised
      ? currentModel
      : typeof option?.currentValue === "string"
        ? option.currentValue
        : null;
    const modelButtons = (option?.options ?? []).map((candidate) => [{
      text: selected === candidate.value ? `✓ ${candidate.name ?? candidate.value}` : (candidate.name ?? candidate.value),
      callback_data: `model:${kind}:${candidate.value}`,
    }]);
    return {
      inline_keyboard: [
        ...modelButtons,
        [{
          text: currentModel === ACP_PROVIDER_DEFAULT ? "✓ Use provider default" : "Use provider default",
          callback_data: `model:${kind}:reset`,
        }],
      ],
    };
  }

  const modelButtons = modelPreference.map((m) => {
    const text = currentModel === m ? `✓ ${m}` : m;
    return [{ text, callback_data: `model:${kind}:${m}` }];
  });
  return {
    inline_keyboard: [
      ...modelButtons,
      [{ text: "Reset to Default", callback_data: `model:${kind}:reset` }],
    ],
  };
}

export function buildModelsText(kind: string, { db, config }: { db: BridgeDb; config: BridgeConfig }): string {
  const bot = config.bots[kind as "codex" | "antigravity" | "claude" | "grok" | "cursor"];
  if (isAcpConfigKind(kind)) {
    const option = getAcpSessionConfigOption(kind, "model");
    const saved = db.getSetting(kind);
    if (!option) {
      return [
        `[${kind} model settings]`,
        "",
        `Current: ${saved === ACP_PROVIDER_DEFAULT ? "provider default" : "provider-controlled"}`,
        "Available: waiting for a live ACP session to advertise model options",
      ].join("\n");
    }
    const advertised = option.options ?? [];
    const savedAdvertised = Boolean(
      saved
      && saved !== ACP_PROVIDER_DEFAULT
      && advertised.some((candidate) => candidate.value === saved)
      && !isAcpSessionConfigValueStale(kind, "model", saved),
    );
    const current = saved === ACP_PROVIDER_DEFAULT
      ? "provider default"
      : savedAdvertised
        ? saved!
        : typeof option.currentValue === "string"
          ? option.currentValue
          : "provider default";
    const available = advertised.length > 0
      ? advertised.map((candidate) => candidate.name && candidate.name !== candidate.value
        ? `${candidate.name} (${candidate.value})`
        : candidate.value).join(", ")
      : "provider-controlled";
    const stale = saved && saved !== ACP_PROVIDER_DEFAULT && !savedAdvertised
      ? `\nStored override ${saved} is no longer advertised and is ignored.`
      : "";
    return `[${kind} model settings]\n\nCurrent: ${current}\nAvailable: ${available}${stale}\n\nSelect a model below:`;
  }

  const current = db.getSetting(kind) || bot.modelPreference[0] || "default";
  const available = bot.modelPreference.length > 0 ? bot.modelPreference.join(", ") : "none configured";
  return `[${kind} model settings]\n\nCurrent: ${current}\nAvailable: ${available}\n\nSelect a model below:`;
}

// Compatibility barrel: preserve the historical bridge imports, but point each
// name at its stable owning module so internal callers can import owners directly.
export {
  runCli, runCliAsync, parseCliResult, buildCliInvocation, buildExecutionOptions,
  isCapacityExhaustedError, getNextFallbackModel, toUserMessage, scrubOutputDir,
  abortCliProcess, abortCliProcessAndWait, shutdownCliProcesses,
  validateBridgeConfig, parseModelPreference, BridgeDb,
  resolveAntigravityConversationId, extractAntigravityConversationId,
  readAntigravityLastConversation, readLatestAntigravityConversationFromLogs,
  setAntigravityModel, ensureAntigravityStateDirs, toAntigravityModelLabel,
  normalizeCliArgs, classifyAnyProviderError, classifyProviderError, isFallbackEligibleProviderError,
};
export { buildTelegramCommands, handleCommand, isBridgeCommand } from "./commands.js";
