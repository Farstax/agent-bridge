import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import { loadInteractiveEnvFile } from "./interactiveEnv.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyVerified,
  verifyConfiguredProviderApiKeys,
  type ProviderApiKeyProbeExecutor,
  type VerifyProviderApiKeyOptions,
} from "./providers/apiKeyAuth.js";
import { hasAgyRuntimePrerequisites, resolveAgyAcpAuthPaths } from "./providers/agyAvailability.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
import { isProviderRuntimeAuthDegraded } from "./providers/runtimeAvailability.js";
import {
  isCursorRouteable,
  isCursorRouteableCached,
  resolveCursorAuthPaths,
  type CursorAvailabilityOptions,
  type CursorStatusSnapshot,
} from "./providers/cursorAvailability.js";
import { isGrokRouteable, resolveGrokAuthPaths } from "./providers/grokAvailability.js";
import { resolveProviderRuntime } from "./providers/acpRuntime.js";
import type { ProviderId } from "./providers/types.js";

export interface InteractiveCliAuthPaths {
  codex: string;
  claude: string;
  antigravity: string[];
  grok: string[];
  cursor: string[];
}

export interface AvailableCliOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  commandExists?: (command: string) => boolean;
  agyRuntimeReady?: () => boolean;
  failedProviders?: ReadonlySet<ProviderId>;
  env?: Record<string, string | undefined>;
  readCursorStatus?: () => CursorStatusSnapshot;
  readCursorVersion?: () => string;
  verifyApiKey?: (provider: ProviderId) => boolean;
  resolveCursorRouteable?: (options: CursorAvailabilityOptions) => boolean;
}

export interface InteractiveCliAuthStartupOptions extends VerifyProviderApiKeyOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Establish bounded native API-key evidence before the interactive runtime
 * makes its first synchronous routing decision. Tests may inject the probe
 * executor; production uses the provider CLIs.
 */
export async function prepareInteractiveCliAuth(
  env: Record<string, string | undefined> = process.env,
  options?: ProviderApiKeyProbeExecutor | VerifyProviderApiKeyOptions,
): Promise<void> {
  const opts: VerifyProviderApiKeyOptions = typeof options === "function"
    ? { execFile: options }
    : (options ?? {});
  await verifyConfiguredProviderApiKeys({ env, ...opts });
}

/**
 * Load the canonical interactive env file before preparing provider auth.
 * This must run during module initialization because index-interactive imports
 * this module before its own body executes and then snapshots availability.
 */
export async function prepareInteractiveCliAuthStartup(
  options: InteractiveCliAuthStartupOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  loadInteractiveEnvFile({ env, processEnv: env, ...(options.cwd ? { cwd: options.cwd } : {}) });
  await prepareInteractiveCliAuth(env, options);
}

if (process.env.NODE_ENV !== "test") {
  await prepareInteractiveCliAuthStartup();
}

export function resolveInteractiveCliAuthPaths(
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): InteractiveCliAuthPaths {
  return {
    codex: join(homeDir, ".codex", "auth.json"),
    claude: join(homeDir, ".claude", ".credentials.json"),
    antigravity: resolveAgyAcpAuthPaths(homeDir, env),
    grok: resolveGrokAuthPaths(homeDir),
    cursor: resolveCursorAuthPaths(homeDir),
  };
}

export function commandExistsOnPath(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getAvailableCliKinds(options: AvailableCliOptions = {}): Set<CliKind> {
  const home = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const env = options.env ?? process.env;
  const failedProviders = new Set(options.failedProviders ?? getQualificationFailedProviders());
  if (
    options.failedProviders === undefined
    && isProviderRuntimeAuthDegraded("claude", home)
  ) {
    failedProviders.add("claude");
  }
  const paths = resolveInteractiveCliAuthPaths(home, env);
  const available = new Set<CliKind>();
  const verifyApiKey = options.verifyApiKey ?? ((provider: ProviderId) =>
    isProviderApiKeyVerified(provider, env));
  const hasRuntime = (provider: ProviderId): boolean =>
    commandExists(resolveProviderRuntime(provider, env).executable);

  const codexAuthenticated = exists(paths.codex)
    || (isProviderApiKeyConfigured("codex", env) && verifyApiKey("codex"));
  if (codexAuthenticated && hasRuntime("codex") && !failedProviders.has("codex")) available.add("codex");

  const claudeAuthenticated = exists(paths.claude)
    || (isProviderApiKeyConfigured("claude", env) && verifyApiKey("claude"));
  if (claudeAuthenticated && hasRuntime("claude") && !failedProviders.has("claude")) available.add("claude");

  const agyAuthenticated = paths.antigravity.some(exists)
    || (isProviderApiKeyConfigured("agy", env) && verifyApiKey("agy"));
  const agyRuntimeReady = options.agyRuntimeReady?.() ?? hasAgyRuntimePrerequisites({ env });
  if (agyAuthenticated && hasRuntime("agy") && agyRuntimeReady && !failedProviders.has("agy")) {
    available.add("antigravity");
  }

  if (hasRuntime("grok") && isGrokRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
    verifyApiKey: () => verifyApiKey("grok"),
  })) available.add("grok");
  const resolveCursorRouteable = options.resolveCursorRouteable ?? isCursorRouteable;
  if (hasRuntime("cursor") && resolveCursorRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
    readStatus: options.readCursorStatus,
    readVersion: options.readCursorVersion,
    verifyApiKey: () => verifyApiKey("cursor"),
  })) available.add("cursor");

  try {
    if (hasRuntime("custom-acp")) available.add("custom-acp");
  } catch {
    // Unconfigured or invalid custom ACP is unavailable; startup/doctor owns diagnostics.
  }

  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;

/**
 * Hot-path variant for every Telegram/Discord update. Every provider check in
 * `getAvailableCliKinds` except Cursor's is a cheap file-existence/PATH read
 * and stays fully fresh here -- caching those would risk exactly the
 * staleness bug this function must not have (e.g. a user finishing Codex or
 * Antigravity auth must show up on their very next message). Only Cursor's
 * check shells out synchronously (`cursor-agent status` / `--version`, each
 * up to a 10s timeout) and blocks the bot's single event loop for every
 * in-flight chat, not just the caller, so only it is routed through
 * `isCursorRouteableCached`'s short bounded TTL.
 */
export function getCachedAvailableCliKinds(options: AvailableCliOptions = {}): Set<CliKind> {
  return getAvailableCliKinds({
    resolveCursorRouteable: isCursorRouteableCached,
    ...options,
  });
}
