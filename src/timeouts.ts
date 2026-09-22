import type { BotKind, RouteableBotKind } from "./types.js";

interface PerKindDefaults {
  cliTimeoutMs: number;
  cliIdleTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

// Provider hard timeouts remain disabled by default. ACP providers now use a
// bounded idle threshold so a live-but-wedged adapter can be restarted by the
// owning logical run (Issue #858). Explicit 0 still disables either timeout.
const DEFAULT_PROVIDER_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULTS: Record<BotKind | "custom-acp", PerKindDefaults> = {
  codex:       { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
  antigravity: { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
  claude:      { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
  grok:        { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
  cursor:      { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
  "custom-acp": { cliTimeoutMs: 0, cliIdleTimeoutMs: DEFAULT_PROVIDER_IDLE_TIMEOUT_MS },
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
export function resolveTimeoutsForKind(kind: RouteableBotKind, env: Env = process.env): ResolvedTimeouts {
  const prefix = kind.toUpperCase().replace(/-/g, "_");
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
