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
import {
  resolveAntigravityConversationId, extractAntigravityConversationId,
  readAntigravityLastConversation, readLatestAntigravityConversationFromLogs,
  setAntigravityModel, ensureAntigravityStateDirs, toAntigravityModelLabel,
} from "./providers/antigravityRuntime.js";
import { isGrokRouteable } from "./providers/grokAvailability.js";
import { normalizeCliArgs } from "./cliArgNormalization.js";
import { classifyAnyProviderError, classifyProviderError, isFallbackEligibleProviderError } from "./providers/errorClassification.js";

export function getBridgeProjectDir(): string {
  return process.env.BRIDGE_PROJECT_DIR || process.cwd();
}

export function getCliWorkingDir(bot?: "codex" | "antigravity" | "claude" | "grok"): string {
  if (bot === "grok" && !isGrokRouteable()) {
    throw new Error("Grok Build is unavailable until authenticated and current provider qualification passes");
  }
  if (bot === "codex" && process.env.CODEX_PROJECT_DIR) return process.env.CODEX_PROJECT_DIR;
  if (bot === "antigravity" && (process.env.ANTIGRAVITY_PROJECT_DIR || process.env.GEMINI_PROJECT_DIR)) {
    return process.env.ANTIGRAVITY_PROJECT_DIR || process.env.GEMINI_PROJECT_DIR!;
  }
  if (bot === "claude" && process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  if (bot === "grok" && process.env.GROK_PROJECT_DIR) return process.env.GROK_PROJECT_DIR;
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

export function buildModelKeyboard(kind: string, modelPreference: string[], currentModel?: string | null): any {
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
  const bot = config.bots[kind as "codex" | "antigravity" | "claude" | "grok"];
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
