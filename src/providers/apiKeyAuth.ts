import { execFileSync } from "node:child_process";
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
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadBotsConfig } from "../config.js";
import type { ProviderId } from "./types.js";

type Env = Record<string, string | undefined>;

export interface ProviderApiKeyAuthCapability {
  readonly envVar: string;
  readonly verification: "bounded_native_turn";
  readonly notes: string;
}

/**
 * Exhaustive API-key capability matrix for every provider on main. Adding a
 * ProviderId fails type-check until its auth contract is classified here.
 */
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
    notes: "Grok Build supports XAI_API_KEY for headless use; Bridge verifies it in an isolated GROK_HOME.",
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

const PROBE_TIMEOUT_MS = 15_000;
const NEGATIVE_CACHE_MS = 30_000;
const verificationCache = new Map<string, { verified: boolean; retryAfterMs: number }>();

export interface VerifyProviderApiKeyOptions {
  env?: Env;
  homeDir?: string;
  execFile?: typeof execFileSync;
  nowMs?: number;
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

export function redactProviderApiKeySecrets(text: string, env: Env = process.env): string {
  let redacted = text;
  const values = PROVIDER_SECRET_ENV_KEYS
    .map((name) => env[name]?.trim())
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    redacted = redacted.split(value).join("[REDACTED_PROVIDER_CREDENTIAL]");
  }
  return redacted;
}

export function clearProviderApiKeyVerificationCache(): void {
  verificationCache.clear();
}

function buildProbeEnv(env: Env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) =>
      !/^TELEGRAM_BOT_TOKEN/.test(key) && !/^TELEGRAM_ALLOWED_USER_IDS/.test(key),
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

/**
 * Agy only consumes GEMINI_API_KEY when modelProvider=gemini. Keep that
 * provider selection scoped to the serialized Bridge run so account auth and
 * user settings are unchanged once the run finishes.
 */
export async function withAntigravityApiKeyProvider<T>(
  homeDir: string,
  env: Env,
  operation: () => Promise<T>,
): Promise<T> {
  if (!isProviderApiKeyConfigured("agy", env)) return operation();
  const restore = applyTemporaryAgyApiKeyProvider(homeDir);
  try {
    return await operation();
  } finally {
    restore();
  }
}

function runProbe(
  provider: ProviderId,
  env: Env,
  homeDir: string,
  execFile: typeof execFileSync,
): void {
  const command = commandForProvider(provider, env);
  const childEnv = buildProbeEnv(env);
  const common = {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: childEnv,
  };

  if (provider === "codex") {
    execFile(command, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "Reply with exactly OK.",
    ], common);
    return;
  }
  if (provider === "claude") {
    execFile(command, [
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
    ], common);
    return;
  }
  if (provider === "agy") {
    const restore = applyTemporaryAgyApiKeyProvider(homeDir);
    try {
      execFile(command, [
        "--sandbox",
        "--print-timeout",
        "15s",
        "--output-format",
        "json",
        "--print",
        "Reply with exactly OK.",
      ], common);
    } finally {
      restore();
    }
    return;
  }
  if (provider === "grok") {
    const grokHome = mkdtempSync(join(tmpdir(), "agent-bridge-grok-auth-"));
    try {
      execFile(command, [
        "-p",
        "Reply with exactly OK.",
        "--output-format",
        "streaming-json",
      ], { ...common, env: { ...childEnv, GROK_HOME: grokHome } });
    } finally {
      rmSync(grokHome, { recursive: true, force: true });
    }
    return;
  }
  execFile(command, [
    "-p",
    "Reply with exactly OK.",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
  ], common);
}

/**
 * A non-empty variable is only a candidate credential. A provider becomes
 * API-key authenticated after its own headless CLI completes a bounded real
 * request. Successful verification is cached for this process by key hash;
 * failures are retried after a short backoff so transient outages recover.
 */
export function verifyProviderApiKey(
  provider: ProviderId,
  options: VerifyProviderApiKeyOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const apiKey = getConfiguredProviderApiKey(provider, env);
  if (!apiKey) return false;

  const key = cacheKey(provider, apiKey);
  const nowMs = options.nowMs ?? Date.now();
  if (options.useCache !== false) {
    const cached = verificationCache.get(key);
    if (cached?.verified) return true;
    if (cached && cached.retryAfterMs > nowMs) return false;
  }

  let verified = false;
  try {
    runProbe(provider, env, options.homeDir ?? homedir(), options.execFile ?? execFileSync);
    verified = true;
  } catch {
    verified = false;
  }

  if (options.useCache !== false) {
    verificationCache.set(key, {
      verified,
      retryAfterMs: verified ? Number.POSITIVE_INFINITY : nowMs + NEGATIVE_CACHE_MS,
    });
  }
  return verified;
}
