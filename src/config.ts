/**
 * PURPOSE: Single source of truth for bot configuration across runtime entry points.
 * Replaces previously-duplicated inline bot config blocks whose drift shipped
 * live configuration defects. Epic 1, ADR-006.
 * INPUTS: process-env-shaped record.
 * OUTPUTS: BridgeConfig.bots map and token-uniqueness validation.
 * NEIGHBORS: src/index-interactive.ts, src/index-discord-interactive.ts, src/types.ts
 */

import { isAbsolute } from "node:path";
import { normalizeAgyModelFamily } from "./effort.js";
import { resolveAgyAcpCommand } from "./providers/agyAcpConfig.js";
import { resolveCodexAcpCommand } from "./providers/codexAcpConfig.js";
import { resolveClaudeAcpCommand } from "./providers/claudeAcpConfig.js";
import { resolveGrokAcpCommand } from "./providers/grokAcpConfig.js";
import { resolveCursorAcpCommand } from "./providers/cursorAcpConfig.js";
import { resolveCustomAcpLaunch } from "./providers/externalAcpLaunch.js";
import type { BotConfig, BotKind, BridgeConfig } from "./types.js";

type Env = Record<string, string | undefined>;

export interface ExecutionCapacityConfig {
  maxConcurrentExecutions: number;
  coordinatorDbPath: string | null;
}

/**
 * A positive cap must have one managed SQLite coordinator shared by every
 * participating surface.  Falling back to each surface's own DB would look
 * configured while silently creating independent caps.
 */
export function resolveExecutionCapacityConfig(env: Env): ExecutionCapacityConfig {
  const raw = env.AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS;
  if (raw === undefined || raw === "") return { maxConcurrentExecutions: 0, coordinatorDbPath: null };
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`Invalid AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS: "${raw}". Must be a non-negative integer.`);
  }
  const maxConcurrentExecutions = Number(raw);
  if (!Number.isSafeInteger(maxConcurrentExecutions)) {
    throw new Error(`Invalid AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS: "${raw}". Must be a safe non-negative integer.`);
  }
  if (maxConcurrentExecutions === 0) return { maxConcurrentExecutions, coordinatorDbPath: null };
  const coordinatorDbPath = env.AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH?.trim();
  if (!coordinatorDbPath || !coordinatorDbPath.startsWith("/")) {
    throw new Error("AGENT_BRIDGE_EXECUTION_COORDINATION_DB_PATH must be an absolute path when AGENT_BRIDGE_MAX_CONCURRENT_EXECUTIONS is positive.");
  }
  return { maxConcurrentExecutions, coordinatorDbPath };
}

export const DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
] as const;

export function parseModelPreference(raw: string | undefined): string[] {
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Agy exposes Gemini effort as low/medium/high suffixes on concrete model IDs.
 * Keep bridge model preference at the family level and collapse qualified
 * legacy triads so one family is attempted once at the selected effort.
 */
export function parseAntigravityModelPreference(raw: string | undefined): string[] {
  const configured = parseModelPreference(raw);
  const source = configured.length > 0 ? configured : [...DEFAULT_ANTIGRAVITY_MODEL_PREFERENCE];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const model of source) {
    const family = normalizeAgyModelFamily(model);
    if (seen.has(family)) continue;
    seen.add(family);
    normalized.push(family);
  }
  return normalized;
}

/**
 * Build bot runtime configs from env. ACP model preferences intentionally do
 * not populate BotConfig.modelPreference: that array is the legacy/native
 * execution catalogue and fallback list. Claude/Codex/Grok/Agy/Cursor preference policy is
 * consumed only after their ACP sessions advertise configOptions.
 */
export function loadBotsConfig(env: Env): Record<BotKind, BotConfig> {
  resolveCustomAcpLaunch(env);
  return {
    codex: {
      token: undefined,
      command: resolveCodexAcpCommand(env),
      modelPreference: [],
    },
    antigravity: {
      token: undefined,
      command: resolveAgyAcpCommand(env),
      modelPreference: [],
    },
    claude: {
      token: undefined,
      command: resolveClaudeAcpCommand(env),
      modelPreference: [],
    },
    grok: {
      token: undefined,
      command: resolveGrokAcpCommand(env),
      modelPreference: [],
    },
    cursor: {
      token: undefined,
      command: resolveCursorAcpCommand(env),
      modelPreference: [],
    },
  };
}

/**
 * Resolve the execution mode for a specific bot kind.
 * Per-bot env vars override the global BRIDGE_EXECUTION_MODE. Kinds default
 * to safe when no explicit mode is configured.
 */
export function resolveExecutionMode(kind: BotKind | "custom-acp", env: Env): "safe" | "trusted" {
  const envKey = kind === "custom-acp" ? "CUSTOM_ACP_EXECUTION_MODE" : `${kind.toUpperCase()}_EXECUTION_MODE`;
  const perBotRaw = env[envKey];
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
  if (raw !== undefined && raw !== "interrupt" && raw !== "queue" && raw !== "augment") {
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
 * required, everything else BridgeConfig defines is optional here. Runtime
 * entry points validate the token needed by their own surface.
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


export interface AutonomyRuntimeConfig {
  enabled: boolean;
  dir: string | null;
  dbPath: string | null;
  maxCycles: number;
  requireEpisodeApproval: boolean;
  maxEpisodesPerDay: number;
}

export const DEFAULT_AUTONOMY_MAX_EPISODES_PER_DAY = 5;

export function parseAutonomyRequireEpisodeApproval(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("AGENT_BRIDGE_AUTONOMY_REQUIRE_EPISODE_APPROVAL must be true or false");
}

export function parseAutonomyMaxEpisodesPerDay(raw: string | undefined): number {
  const value = Number(raw || DEFAULT_AUTONOMY_MAX_EPISODES_PER_DAY);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("AGENT_BRIDGE_AUTONOMY_MAX_EPISODES_PER_DAY must be a positive integer");
  }
  return value;
}

export function resolveAutonomyRuntimeConfig(
  env: Env,
): AutonomyRuntimeConfig {
  const requireEpisodeApproval = parseAutonomyRequireEpisodeApproval(env.AGENT_BRIDGE_AUTONOMY_REQUIRE_EPISODE_APPROVAL);
  const maxEpisodesPerDay = parseAutonomyMaxEpisodesPerDay(env.AGENT_BRIDGE_AUTONOMY_MAX_EPISODES_PER_DAY);
  const dir = env.AGENT_BRIDGE_AUTONOMY_DIR?.trim() || null;
  const dbPath = env.AGENT_BRIDGE_AUTONOMY_DB_PATH?.trim() || null;
  if (Boolean(dir) !== Boolean(dbPath)) {
    throw new Error("AGENT_BRIDGE_AUTONOMY_DIR and AGENT_BRIDGE_AUTONOMY_DB_PATH must be configured together");
  }
  if (dir && !isAbsolute(dir)) throw new Error("AGENT_BRIDGE_AUTONOMY_DIR must be absolute");
  if (dbPath && !isAbsolute(dbPath)) throw new Error("AGENT_BRIDGE_AUTONOMY_DB_PATH must be absolute");

  const maxCycles = Number(env.AGENT_BRIDGE_AUTONOMY_MAX_CYCLES || 3);
  if (!Number.isInteger(maxCycles) || maxCycles < 1) {
    throw new Error("AGENT_BRIDGE_AUTONOMY_MAX_CYCLES must be a positive integer");
  }

  return { enabled: Boolean(dir && dbPath), dir, dbPath, maxCycles, requireEpisodeApproval, maxEpisodesPerDay };
}
