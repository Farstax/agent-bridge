import type { CliKind } from "./interactiveBot.js";

type Env = Record<string, string | undefined>;

export interface TelegramRuntimePolicy {
  providerLock: CliKind | null;
  cliKinds: CliKind[];
  token: string | undefined;
  surfaceIdentity: string;
  pollKind: CliKind;
  cliSwitchingEnabled: boolean;
}

const PROVIDERS = new Set<CliKind>(["codex", "claude", "antigravity"]);

function parseProviderLock(raw: string | undefined): CliKind | null {
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
    };
  }

  return {
    providerLock,
    cliKinds: [providerLock],
    token: lockedToken(env, providerLock),
    surfaceIdentity: `telegram:${providerLock}`,
    pollKind: providerLock,
    cliSwitchingEnabled: false,
  };
}
