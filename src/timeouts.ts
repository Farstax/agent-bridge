import type { BotKind } from "./types.js";

interface PerKindDefaults {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
}

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

function envNum(name: string): number | null {
  const v = process.env[name];
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Like envNum(), but an explicit "0" resolves to 0 (disabled) instead of falling through. */
function envTimeoutMs(name: string): number | null {
  const v = process.env[name];
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
export function resolveTimeoutsForKind(kind: BotKind): ResolvedTimeouts {
  const prefix = kind.toUpperCase();
  const defaults = DEFAULTS[kind];
  return {
    cliTimeoutMs:
      envTimeoutMs(`${prefix}_CLI_TIMEOUT_MS`) ??
      envTimeoutMs("CLI_TIMEOUT_MS") ??
      defaults.cliTimeoutMs,
    cliIdleTimeoutMs:
      envTimeoutMs(`${prefix}_CLI_IDLE_TIMEOUT_MS`) ??
      envTimeoutMs("CLI_IDLE_TIMEOUT_MS") ??
      defaults.cliIdleTimeoutMs,
    fetchTimeoutMs:
      envNum("TELEGRAM_FETCH_TIMEOUT_MS") ??
      envNum("FETCH_TIMEOUT_MS") ??
      DEFAULT_FETCH_TIMEOUT_MS,
  };
}
