/**
 * PURPOSE: Single source of truth for bot configuration across all entry points.
 * Replaces the four previously-duplicated inline bots blocks (index.ts,
 * index-interactive.ts and index-discord-interactive.ts) whose
 * drift shipped live configuration defects. Epic 1, ADR-006.
 * INPUTS: process-env-shaped record.
 * OUTPUTS: BridgeConfig.bots map and token-uniqueness validation.
 * NEIGHBORS: src/index*.ts, src/types.ts
 */

import type { BotConfig, BotKind, BridgeConfig } from "./types.js";

type Env = Record<string, string | undefined>;

export function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Build the three bot configs from env. Tokens are omitted by default because
 * most surfaces (interactive and discord) construct engines without
 * per-bot Telegram tokens; only src/index.ts runs one polling bot per token.
 */
export function loadBotsConfig(env: Env, opts: { withTokens?: boolean } = {}): Record<BotKind, BotConfig> {
  const token = (v: string | undefined) => (opts.withTokens ? v : undefined);
  return {
    codex: {
      token: token(env.TELEGRAM_BOT_TOKEN_CODEX),
      command: env.CODEX_COMMAND || "codex",
      modelPreference: parseModelPreference(env.CODEX_MODEL_PREFERENCE),
    },
    antigravity: {
      token: token(env.TELEGRAM_BOT_TOKEN_ANTIGRAVITY || env.TELEGRAM_BOT_TOKEN_GEMINI),
      command: env.ANTIGRAVITY_COMMAND || env.GEMINI_COMMAND || "agy",
      modelPreference: parseModelPreference(env.ANTIGRAVITY_MODEL_PREFERENCE || env.GEMINI_MODEL_PREFERENCE),
    },
    claude: {
      token: token(env.TELEGRAM_BOT_TOKEN_CLAUDE),
      command: env.CLAUDE_COMMAND || "claude",
      modelPreference: parseModelPreference(env.CLAUDE_MODEL_PREFERENCE),
    },
  };
}

/**
 * Resolve the execution mode for a specific bot kind.
 * Per-bot env vars override the global BRIDGE_EXECUTION_MODE. Kinds default
 * to safe when no explicit mode is configured.
 */
export function resolveExecutionMode(kind: BotKind, env: Env): "safe" | "trusted" {
  const perBotRaw = env[`${kind.toUpperCase()}_EXECUTION_MODE`];
  if (perBotRaw === "safe" || perBotRaw === "trusted") return perBotRaw;
  const globalRaw = env.BRIDGE_EXECUTION_MODE;
  if (globalRaw === "safe" || globalRaw === "trusted") return globalRaw;
  return "safe";
}

/**
 * Resolve the busy-message admission policy (Issue #217). Unlike
 * resolveExecutionMode, this is intentionally a single flat setting — no
 * per-CLI override — because the interactive surface must use one policy
 * regardless of which CLI is currently selected.
 */
export function resolveBusyMessageMode(env: Env): "augment" | "interrupt" | "queue" {
  const raw = env.BRIDGE_BUSY_MESSAGE_MODE;
  return raw === "interrupt" || raw === "queue" || raw === "augment" ? raw : "augment";
}

/** Fail startup when BRIDGE_BUSY_MESSAGE_MODE is set to anything other than augment|interrupt|queue. */
export function validateBusyMessageModeEnv(env: Env): void {
  const raw = env.BRIDGE_BUSY_MESSAGE_MODE;
  if (raw !== undefined && raw !== "augment" && raw !== "interrupt" && raw !== "queue") {
    throw new Error(
      `Invalid BRIDGE_BUSY_MESSAGE_MODE: "${raw}". Must be "augment", "interrupt" or "queue".`
    );
  }
}

/**
 * Fail fast when two surfaces are configured with the same Telegram token.
 * Two pollers on one token fight over getUpdates and Telegram rejects both —
 * this took the Antigravity bridge offline in production (Risk R2).
 */
/**
 * Config shape validateBridgeConfig() actually inspects: allowedUserIds is
 * required, everything else BridgeConfig defines is optional here (bot
 * validation is intentionally skipped — each service validates its own bot
 * in index.ts, allowing e.g. the antigravity service to run without a
 * codex token and vice versa).
 */
export type ValidatableBridgeConfig = Pick<BridgeConfig, "allowedUserIds"> & Partial<Omit<BridgeConfig, "allowedUserIds">>;

/**
 * Validates the bridge configuration.
 */
export function validateBridgeConfig(config: ValidatableBridgeConfig): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.allowedUserIds?.size) {
    errors.push("TELEGRAM_ALLOWED_USER_IDS is required");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateTokenUniqueness(tokens: Record<string, string | undefined>): void {
  const seen = new Map<string, string>();
  for (const [surface, tok] of Object.entries(tokens)) {
    if (!tok) continue;
    const existing = seen.get(tok);
    if (existing) {
      throw new Error(
        `Duplicate Telegram bot token: surfaces "${existing}" and "${surface}" share the same token. ` +
        `Each polling surface needs its own bot token (two getUpdates pollers on one token conflict).`
      );
    }
    seen.set(tok, surface);
  }
}
