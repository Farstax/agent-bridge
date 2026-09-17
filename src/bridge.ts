/**
 * PURPOSE: Common helper and layout generation functions for Telegram interaction.
 * INPUTS: DB client, configuration settings, and messages context.
 * OUTPUTS: Working directories, layouts and parsed targets.
 * NEIGHBORS: src/index.ts, src/cli.ts, src/db.ts
 * LOGIC: Provides interface checks, text extraction helpers, inline keyboard markup setups, and path resolves.
 */

import type { TelegramMessage, BridgeConfig, BotKind, RouteableBotKind } from "./types.js";
import {
  runCli, runCliAsync, parseCliResult, buildCliInvocation, buildExecutionOptions,
  isCapacityExhaustedError, getNextFallbackModel, toUserMessage, scrubOutputDir,
} from "./cli.js";
import { abortCliProcess, abortCliProcessAndWait, shutdownCliProcesses } from "./cliSupervisor.js";
import { validateBridgeConfig, parseModelPreference } from "./config.js";
import { BridgeDb } from "./db.js";
import {
  getAcpSessionConfigOption,
  hasAcpProviderDefaultIntent,
  hasAcpSessionConfigSnapshot,
  isAcpProviderDefaultSelected,
  isAcpSessionConfigValueStale,
} from "./acp/sessionConfig.js";
import { buildAcpTelegramConfigCallbackData } from "./acp/telegramConfigCallback.js";
import { isCursorRouteable } from "./providers/cursorAvailability.js";
import { isGrokRouteable } from "./providers/grokAvailability.js";
import { isAcpBackedBot } from "./providers/registry.js";
import { classifyAnyProviderError, classifyProviderError, isFallbackEligibleProviderError } from "./providers/errorClassification.js";
import { resolveCustomAcpWorkingDir } from "./providers/externalAcpLaunch.js";

export function getBridgeProjectDir(): string {
  return process.env.BRIDGE_PROJECT_DIR || process.cwd();
}

export function getCliWorkingDir(bot?: RouteableBotKind): string {
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
  if (bot === "custom-acp") return resolveCustomAcpWorkingDir(process.env);
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
  return isAcpBackedBot(kind);
}

export function buildModelKeyboard(
  kind: string,
  modelPreference: string[],
  currentModel?: string | null,
  providerDefaultSelected = isAcpConfigKind(kind) && hasAcpProviderDefaultIntent(kind, "model"),
): any {
  if (isAcpConfigKind(kind)) {
    const option = getAcpSessionConfigOption(kind, "model");
    const currentIsAdvertised = Boolean(
      currentModel
      && option?.options?.some((candidate) => candidate.value === currentModel)
      && !isAcpSessionConfigValueStale(kind, "model", currentModel),
    );
    const selected = providerDefaultSelected
      ? null
      : currentIsAdvertised
        ? currentModel
        : typeof option?.currentValue === "string"
          ? option.currentValue
          : null;
    const modelButtons = (option?.options ?? []).map((candidate) => [{
      text: selected === candidate.value ? `✓ ${candidate.name ?? candidate.value}` : (candidate.name ?? candidate.value),
      callback_data: buildAcpTelegramConfigCallbackData(kind, "model", candidate.value),
    }]);
    return {
      inline_keyboard: [
        ...modelButtons,
        [{
          text: providerDefaultSelected ? "✓ Use provider default" : "Use provider default",
          callback_data: buildAcpTelegramConfigCallbackData(kind, "model", null),