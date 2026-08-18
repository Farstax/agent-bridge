import { isAbsolute } from "node:path";
import type { CliKind } from "./interactiveBot.js";

type Env = Record<string, string | undefined>;

export interface TelegramRuntimePolicy {
  providerLock: CliKind | null;
  cliKinds: CliKind[];
  token: string | undefined;
  surfaceIdentity: string;
  pollKind: CliKind;
  cliSwitchingEnabled: boolean;
  databaseRole: "shared" | "interactive";
  databaseServiceId: "telegram:standalone" | "telegram:interactive";
}

export interface AutonomyRuntimeConfig {
  enabled: boolean;
  dir: string | null;
  dbPath: string | null;
  maxCycles: number;
}

const PROVIDERS = new Set<CliKind>(["codex", "claude", "antigravity"]);

export function parseProviderLock(raw: string | undefined): CliKind | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!PROVIDERS.has(value as CliKind)) {
    throw new Error(
      `Invalid BRIDGE_PROVIDER_LOCK: "${value}". Must be "codex", "claude" or "antigravity".`,
    );
  }
  return value as CliKind;
}

function lockedToken(env: Env, provider: CliKind): string | undefined {
  if (provider === "codex") return env.TELEGRAM_BOT_TOKEN_CODEX;
  if (provider === "claude") return env.TELEGRAM_BOT_TOKEN_CLAUDE;
  return env.TELEGRAM_BOT_TOKEN_ANTIGRAVITY || env.TELEGRAM_BOT_TOKEN_GEMINI;
}

export function resolveTelegramRuntimePolicy(
  env: Env,
  unlockedCliKinds: CliKind[],
): TelegramRuntimePolicy {
  const providerLock = parseProviderLock(env.BRIDGE_PROVIDER_LOCK);
  if (!providerLock) {
    return {
      providerLock: null,
      cliKinds: unlockedCliKinds,
      token: env.TELEGRAM_BOT_TOKEN_INTERACTIVE,
      surfaceIdentity: "telegram:interactive",
      pollKind: "codex",
      cliSwitchingEnabled: true,
      databaseRole: "interactive",
      databaseServiceId: "telegram:interactive",
    };
  }

  return {
    providerLock,
    cliKinds: [providerLock],
    token: lockedToken(env, providerLock),
    surfaceIdentity: `telegram:${providerLock}`,
    pollKind: providerLock,
    cliSwitchingEnabled: false,
    databaseRole: "shared",
    databaseServiceId: "telegram:standalone",
  };
}

export function resolveAutonomyRuntimeConfig(
  env: Env,
  providerLock: CliKind | null,
): AutonomyRuntimeConfig {
  if (providerLock) {
    return { enabled: false, dir: null, dbPath: null, maxCycles: 3 };
  }

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

  return { enabled: Boolean(dir && dbPath), dir, dbPath, maxCycles };
}
