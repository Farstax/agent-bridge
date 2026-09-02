import type { BotKind } from "./types.js";

interface PerKindDefaults {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

// Per-CLI built-in defaults.
// Canonical default (Issue #177): both hard and idle timeouts are disabled
// (0) unless explicitly configured. 0 means "no timeout" throughout this
// module and in runSupervisedProcess().
const DEFAULTS: Record<BotKind, PerKindDefaults> = {
  codex:       { cliTimeoutMs: 0, cliIdleTimeoutMs: 0 },
  antigravity: { cliTimeoutMs: 0, cliIdleTimeoutMs: 0 },
  claude:      { cliTimeoutMs: 0, cliIdleTimeoutMs: 0 },
  grok:        { cliTimeoutMs: 0, cliIdleTimeoutMs: 0 },
  cursor:      { cliTimeoutMs: 0, cliIdleTimeoutMs: 0 },
};

const DEFAULT_FETCH_TIMEOUT_MS = 45_000;

function envNum(name: string, env: Env): number | null {
  const v = env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Like envNum(), but an explicit "0" resolves to 0 (disabled) instead of falling through. */
function envTimeoutMs(name: string, env: Env): number | null {
  const v = env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface ResolvedTimeouts {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
  fetchTimeoutMs: number;
}

/**
 * Resolve timeout values for a specific bot kind.
 *
 * Precedence (highest first):
 *   1. Per-CLI env var  — e.g. ANTIGRAVITY_CLI_TIMEOUT_MS, ANTIGRAVITY_CLI_IDLE_TIMEOUT_MS
 *   2. Global env var   — CLI_TIMEOUT_MS, CLI_IDLE_TIMEOUT_MS
 *   3. Built-in default — per-kind table above
 *
 * Fetch timeout (Telegram HTTP only, never kills CLI subprocess):
 *   TELEGRAM_FETCH_TIMEOUT_MS → FETCH_TIMEOUT_MS → 45 000 ms
 */
export function resolveTimeoutsForKind(kind: BotKind, env: Env = process.env): ResolvedTimeouts {
  const prefix = kind.toUpperCase();
  const defaults = DEFAULTS[kind];
  return {
    cliTimeoutMs:
      envTimeoutMs(`${prefix}_CLI_TIMEOUT_MS`, env) ??
      envTimeoutMs("CLI_TIMEOUT_MS", env) ??
      defaults.cliTimeoutMs,
    cliIdleTimeoutMs:
      envTimeoutMs(`${prefix}_CLI_IDLE_TIMEOUT_MS`, env) ??
      envTimeoutMs("CLI_IDLE_TIMEOUT_MS", env) ??
      defaults.cliIdleTimeoutMs,
    fetchTimeoutMs:
      envNum("TELEGRAM_FETCH_TIMEOUT_MS", env) ??
      envNum("FETCH_TIMEOUT_MS", env) ??
      DEFAULT_FETCH_TIMEOUT_MS,
  };
}
