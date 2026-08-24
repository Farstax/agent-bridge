import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadBotsConfig } from "../config.js";
import type { BotKind } from "../types.js";
import type { ProviderId } from "./types.js";

type Env = Record<string, string | undefined>;

export interface ProviderApiKeyAuthCapability {
  readonly envVar: string;
  readonly verification: "bounded_native_turn";
  readonly notes: string;
}

export const PROVIDER_API_KEY_AUTH: Readonly<Record<ProviderId, ProviderApiKeyAuthCapability>> = {
  codex: {
    envVar: "CODEX_API_KEY",
    verification: "bounded_native_turn",
    notes: "Codex exec reads CODEX_API_KEY directly; OPENAI_API_KEY is not the Bridge runtime contract.",
  },
  claude: {
    envVar: "ANTHROPIC_API_KEY",
    verification: "bounded_native_turn",
    notes: "Claude local auth status is not authoritative for request usability, so Bridge verifies with print mode.",
  },
  agy: {
    envVar: "GEMINI_API_KEY",
    verification: "bounded_native_turn",
    notes: "Agy requires modelProvider=gemini while the key is used; Bridge applies that setting only around the run.",
  },
  grok: {
    envVar: "XAI_API_KEY",
    verification: "bounded_native_turn",
    notes: "Grok Build supports XAI_API_KEY for headless use; Bridge verifies it without account state.",
  },
  cursor: {
    envVar: "CURSOR_API_KEY",
    verification: "bounded_native_turn",
    notes: "Cursor Agent supports CURSOR_API_KEY for headless automation.",
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
const PROVIDER_ALLOWED_SECRET_ENV_KEYS: Readonly<Record<ProviderId, ReadonlySet<string>>> = {
  codex: new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]),
  claude: new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
  agy: new Set(["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
  grok: new Set(["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"]),
  cursor: new Set(["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]),
};
const PROBE_TIMEOUT_MS = 15_000;
const verificationCache = new Map<string, boolean>();

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

export interface VerifyProviderApiKeyOptions {
  env?: Env;
  execFile?: ProviderApiKeyProbeExecutor;
  useCache?: boolean;
}

export function getProviderApiKeyCapability(provider: string): ProviderApiKeyAuthCapability | null {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_API_KEY_AUTH, provider)) return null;
  return PROVIDER_API_KEY_AUTH[provider as ProviderId];
}

export function getConfiguredProviderApiKey(provider: ProviderId, env: Env = process.env): string | null {
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
  const apiKey = getConfiguredProviderApiKey(provider, env);
  if (!apiKey) return false;
  return verificationCache.get(cacheKey(provider, apiKey)) === true;
}

/**
 * Keep provider credentials out of unrelated provider children. The issue-572
 * candidate key itself is withheld until its isolated native probe has passed,
 * so a bad optional key cannot override an otherwise valid account session.
 */
export function filterProviderCredentialEnv(
  bot: BotKind | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!bot) return { ...env };
  const provider: ProviderId = bot === "antigravity" ? "agy" : bot;
  const allowed = PROVIDER_ALLOWED_SECRET_ENV_KEYS[provider];
  const candidateKey = PROVIDER_API_KEY_AUTH[provider].envVar;
  const candidateVerified = isProviderApiKeyVerified(provider, env);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (!PROVIDER_SECRET_ENV_KEY_SET.has(key)) return true;
      if (!allowed.has(key)) return false;
      if (key === candidateKey) return candidateVerified;
      return true;
    }),
  );
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
}

function buildProbeEnv(provider: ProviderId, env: Env): NodeJS.ProcessEnv {
  const activeKey = PROVIDER_API_KEY_AUTH[provider].envVar;
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !/^TELEGRAM_BOT_TOKEN/.test(key)
      && !/^TELEGRAM_ALLOWED_USER_IDS/.test(key)
      && (!PROVIDER_SECRET_ENV_KEY_SET.has(key) || key === activeKey),
    ),
  );
}

function commandForProvider(provider: ProviderId, env: Env): string {
  const bots = loadBotsConfig(env);
  if (provider === "agy") return bots.antigravity.command;
  return bots[provider].command;
}

function cacheKey(provider: ProviderId, apiKey: string): string {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex");
  return `${provider}:${fingerprint}`;
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function applyTemporaryAgyApiKeyProvider(homeDir: string): () => void {
  const settingsPath = join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const existed = existsSync(settingsPath);
  let settings: Record<string, unknown> = {};
  if (existed) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  const hadModelProvider = Object.prototype.hasOwnProperty.call(settings, "modelProvider");
  const previousModelProvider = settings.modelProvider;
  settings.modelProvider = "gemini";
  writeSettings(settingsPath, settings);

  return () => {
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    if (hadModelProvider) current.modelProvider = previousModelProvider;
    else delete current.modelProvider;

    if (!existed && Object.keys(current).length === 0) {
      rmSync(settingsPath, { force: true });
      return;
    }
    writeSettings(settingsPath, current);
  };
}

export function hasAntigravityAccountAuth(homeDir: string): boolean {
  return [
    join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(homeDir, ".gemini", "oauth_creds.json"),
  ].some(existsSync);
}

/**
 * Account auth remains Agy's default. With no account credential, a configured
 * key is verified asynchronously before the Gemini setting is applied. Normal
 * runtime calls hit the fingerprint cache; qualification can establish the
 * same evidence without a separate unsafe execution path.
 */
export async function withAntigravityApiKeyProvider<T>(
  homeDir: string,
  env: Env,
  operation: () => Promise<T>,
): Promise<T> {
  if (hasAntigravityAccountAuth(homeDir) || !isProviderApiKeyConfigured("agy", env)) {
    return operation();
  }
  const verified = isProviderApiKeyVerified("agy", env)
    || await verifyProviderApiKey("agy", { env });
  if (!verified) return operation();

  const restore = applyTemporaryAgyApiKeyProvider(homeDir);
  try {
    return await operation();
  } finally {
    restore();
  }
}

const defaultProbeExecutor: ProviderApiKeyProbeExecutor = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => {
      if (error) reject(error);
      else resolve(undefined);
    });
  });

async function runProbe(
  provider: ProviderId,
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
    if (provider === "codex") {
      await execute(command, [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "Reply with exactly OK.",
      ], { ...common, env: { ...childEnv, CODEX_HOME: join(probeHome, ".codex") } });
      return;
    }
    if (provider === "claude") {
      await execute(command, [
        "--print",
        "--tools",
        "",
        "--disable-slash-commands",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--output-format",
        "json",
        "Reply with exactly OK.",
      ], { ...common, env: { ...childEnv, CLAUDE_CONFIG_DIR: join(probeHome, ".claude") } });
      return;
    }
    if (provider === "agy") {
      writeSettings(join(probeHome, ".gemini", "antigravity-cli", "settings.json"), { modelProvider: "gemini" });
      await execute(command, [
        "--sandbox",
        "--print-timeout",
        "15s",
        "--output-format",
        "json",
        "--print",
        "Reply with exactly OK.",
      ], common);
      return;
    }
    if (provider === "grok") {
      await execute(command, [
        "-p",
        "Reply with exactly OK.",
        "--output-format",
        "streaming-json",
      ], { ...common, env: { ...childEnv, GROK_HOME: join(probeHome, ".grok") } });
      return;
    }
    await execute(command, [
      "-p",
      "Reply with exactly OK.",
      "--output-format",
      "json",
      "--mode",
      "ask",
      "--trust",
    ], common);
  } finally {
    rmSync(probeHome, { recursive: true, force: true });
  }
}

export async function verifyProviderApiKey(
  provider: ProviderId,
  options: VerifyProviderApiKeyOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const apiKey = getConfiguredProviderApiKey(provider, env);
  if (!apiKey) return false;

  const key = cacheKey(provider, apiKey);
  if (options.useCache !== false && verificationCache.has(key)) {
    return verificationCache.get(key) === true;
  }

  let verified = false;
  try {
    await runProbe(provider, env, options.execFile ?? defaultProbeExecutor);
    verified = true;
  } catch {
    verified = false;
  }

  if (options.useCache !== false) verificationCache.set(key, verified);
  return verified;
}

export async function verifyConfiguredProviderApiKeys(
  options: VerifyProviderApiKeyOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const providers = (Object.keys(PROVIDER_API_KEY_AUTH) as ProviderId[])
    .filter((provider) => isProviderApiKeyConfigured(provider, env));
  await Promise.all(providers.map((provider) => verifyProviderApiKey(provider, { ...options, env })));
}
