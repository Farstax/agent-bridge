import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBotsConfig } from "../config.js";
import type { BotKind } from "../types.js";
import { resolveProviderRuntime } from "./acpRuntime.js";
import { applyProviderChildEnvPolicy, getAcpProviderPolicy } from "./registry.js";
import { isManagedProviderId, type ManagedProviderId, type ProviderId } from "./types.js";

type Env = Record<string, string | undefined>;

export interface ProviderApiKeyAuthCapability {
  readonly envVar: string;
  readonly verification: "bounded_native_turn" | "bounded_acp_turn";
  readonly notes: string;
}

type ProviderApiKeyAuthDefinition = Omit<ProviderApiKeyAuthCapability, "verification">;

export const PROVIDER_API_KEY_AUTH: Readonly<Record<ManagedProviderId, ProviderApiKeyAuthDefinition>> = {
  codex: {
    envVar: "CODEX_API_KEY",
    notes: "Codex verifies through the managed ACP adapter's authenticate + bounded prompt path.",
  },
  claude: {
    envVar: "ANTHROPIC_API_KEY",
    notes: "Claude verifies the key through the selected managed ACP adapter with an isolated bounded prompt.",
  },
  agy: {
    envVar: "GEMINI_API_KEY",
    notes: "Agy ACP authenticates with workspace-local oauth-personal credentials under ~/.gemini/antigravity-acp/; GEMINI_API_KEY is redacted when present but is not a Bridge-managed ACP auth method.",
  },
  grok: {
    envVar: "XAI_API_KEY",
    notes: "Grok Build supports XAI_API_KEY for headless use; Bridge verifies it without account state.",
  },
  cursor: {
    envVar: "CURSOR_API_KEY",
    notes: "Cursor verifies CURSOR_API_KEY through the selected ACP adapter with an isolated bounded prompt.",
  },
};

const PROVIDER_SECRET_ENV_KEYS = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

const PROVIDER_SECRET_ENV_KEY_SET = new Set<string>(PROVIDER_SECRET_ENV_KEYS);
const PROVIDER_ALLOWED_SECRET_ENV_KEYS: Readonly<Record<ManagedProviderId, ReadonlySet<string>>> = {
  codex: new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]),
  claude: new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
  agy: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  cursor: new Set(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]),
};
const PROBE_TIMEOUT_MS = 15_000;
export const PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS = 30_000;
const verificationCache = new Map<string, boolean>();
const verificationFailures = new Map<string, number>();
const verificationInFlight = new Map<string, Promise<boolean>>();

interface ProbeExecOptions {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "pipe"];
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type ProviderApiKeyProbeExecutor = (
  command: string,
  args: string[],
  options: ProbeExecOptions,
) => Promise<unknown>;

export type AcpApiKeyProbeExecutor = (
  provider: ManagedProviderId,
  env: NodeJS.ProcessEnv,
) => Promise<void>;

export interface VerifyProviderApiKeyOptions {
  env?: Env;
  execFile?: ProviderApiKeyProbeExecutor;
  /** Generic test seam for ACP-backed providers. Production uses registered provider policy. */
  acpProbe?: AcpApiKeyProbeExecutor;
  useCache?: boolean;
}

export function getProviderApiKeyCapability(provider: string): ProviderApiKeyAuthCapability | null {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_API_KEY_AUTH, provider)) return null;
  const providerId = provider as ManagedProviderId;
  return {
    ...PROVIDER_API_KEY_AUTH[providerId],
    verification: getAcpProviderPolicy(providerId)?.verifyApiKey
      ? "bounded_acp_turn"
      : "bounded_native_turn",
  };
}

export function getConfiguredProviderApiKey(provider: ProviderId, env: Env = process.env): string | null {
  if (!isManagedProviderId(provider)) return null;
  const value = env[PROVIDER_API_KEY_AUTH[provider].envVar]?.trim();
  return value || null;
}

export function isProviderApiKeyConfigured(provider: ProviderId, env: Env = process.env): boolean {
  return getConfiguredProviderApiKey(provider, env) !== null;
}

export function getProviderApiKeySecretValues(env: Env = process.env): string[] {
  return [...new Set(
    PROVIDER_SECRET_ENV_KEYS
      .map((name) => env[name]?.trim())
      .filter((value): value is string => Boolean(value)),
  )].sort((a, b) => b.length - a.length);
}

export function isProviderApiKeyVerified(provider: ProviderId, env: Env = process.env): boolean {
  if (!isManagedProviderId(provider)) return false;
  const apiKey = getConfiguredProviderApiKey(provider, env);
  if (!apiKey) return false;
  return verificationCache.get(cacheKey(provider, apiKey, env)) === true;
}

/**
 * Keep provider credentials out of unrelated provider children. Candidate keys
 * are withheld until their selected provider runtime has verified them.
 */
export function filterProviderCredentialEnv(
  bot: BotKind | "custom-acp" | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!bot) {
    return applyProviderChildEnvPolicy(null, env);
  }
  const provider: ProviderId = bot === "antigravity" ? "agy" : bot;
  const managedProvider = isManagedProviderId(provider) ? provider : null;
  const allowed = managedProvider ? PROVIDER_ALLOWED_SECRET_ENV_KEYS[managedProvider] : null;
  const candidateKey = managedProvider ? PROVIDER_API_KEY_AUTH[managedProvider].envVar : null;
  const candidateVerified = managedProvider ? isProviderApiKeyVerified(managedProvider, env) : false;
  const out = Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (!PROVIDER_SECRET_ENV_KEY_SET.has(key)) return true;
      if (!managedProvider || !allowed?.has(key)) return false;
      if (key === candidateKey) return candidateVerified;
      return true;
    }),
  );

  return applyProviderChildEnvPolicy(provider, out);
}

export function redactProviderApiKeySecrets(text: string, env: Env = process.env): string {
  let redacted = text;
  for (const value of getProviderApiKeySecretValues(env)) {
    redacted = redacted.split(value).join("[REDACTED_PROVIDER_CREDENTIAL]");
  }
  return redacted;
}

export function clearProviderApiKeyVerificationCache(): void {
  verificationCache.clear();
  verificationFailures.clear();
  verificationInFlight.clear();
}

function buildProbeEnv(provider: ManagedProviderId, env: Env): NodeJS.ProcessEnv {
  const activeKey = PROVIDER_API_KEY_AUTH[provider].envVar;
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !/^TELEGRAM_BOT_TOKEN/.test(key)
      && !/^TELEGRAM_ALLOWED_USER_IDS/.test(key)
      && (!PROVIDER_SECRET_ENV_KEY_SET.has(key) || key === activeKey),
    ),
  );
}

function commandForProvider(provider: ManagedProviderId, env: Env): string {
  const bots = loadBotsConfig(env);
  if (provider === "agy") return bots.antigravity.command;
  return bots[provider].command;
}

function verificationScope(provider: ManagedProviderId, env: Env): string {
  return resolveProviderRuntime(provider, env).runtimeIdentity;
}

function cacheKey(provider: ManagedProviderId, apiKey: string, env: Env): string {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  return `${provider}:${verificationScope(provider, env)}:${fingerprint}`;
}

const defaultProbeExecutor: ProviderApiKeyProbeExecutor = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => {
      if (error) reject(error);
      else resolve(undefined);
    });
  });

async function runNativeProbe(
  provider: ManagedProviderId,
  env: Env,
  execute: ProviderApiKeyProbeExecutor,
): Promise<void> {
  const command = commandForProvider(provider, env);
  const probeHome = mkdtempSync(join(tmpdir(), `agent-bridge-${provider}-auth-`));
  const childEnv = {
    ...buildProbeEnv(provider, env),
    HOME: probeHome,
  };
  const common: ProbeExecOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: childEnv,
  };

  try {
    void execute;
    void command;
    void common;
    throw new Error(`Native API-key probe is not supported for ${provider}`);
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
}

export async function verifyProviderApiKey(
  provider: ProviderId,
  options: VerifyProviderApiKeyOptions = {},
): Promise<boolean> {
  if (!isManagedProviderId(provider)) return false;
  const env = options.env ?? process.env;
  const apiKey = getConfiguredProviderApiKey(provider, env);
  if (!apiKey) return false;

  const key = cacheKey(provider, apiKey, env);
  if (options.useCache !== false) {
    if (verificationCache.get(key) === true) return true;
    const failedAt = verificationFailures.get(key);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < PROVIDER_API_KEY_NEGATIVE_CACHE_TTL_MS) return false;
      verificationFailures.delete(key);
    }
    const inFlight = verificationInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const verification = (async () => {
    let verified = false;
    try {
      const acpProbe = getAcpProviderPolicy(provider)?.verifyApiKey;
      if (acpProbe) {
        const probeEnv = buildProbeEnv(provider, env);
        if (options.acpProbe) await options.acpProbe(provider, probeEnv);
        else await acpProbe(probeEnv);
      } else {
        await runNativeProbe(provider, env, options.execFile ?? defaultProbeExecutor);
      }
      verified = true;
    } catch {
      verified = false;
    }
    if (options.useCache !== false) {
      if (verified) {
        verificationCache.set(key, true);
        verificationFailures.delete(key);
      } else {
        verificationFailures.set(key, Date.now());
      }
    }
    return verified;
  })();

  if (options.useCache === false) return verification;
  verificationInFlight.set(key, verification);
  try {
    return await verification;
  } finally {
    if (verificationInFlight.get(key) === verification) verificationInFlight.delete(key);
  }
}

export async function verifyConfiguredProviderApiKeys(
  options: VerifyProviderApiKeyOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const providers = (Object.keys(PROVIDER_API_KEY_AUTH) as ManagedProviderId[])
    .filter((provider) => isProviderApiKeyConfigured(provider, env));
  await Promise.all(providers.map((provider) => verifyProviderApiKey(provider, { ...options, env })));
}
