import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import { loadInteractiveEnvFile } from "./interactiveEnv.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyVerified,
  verifyConfiguredProviderApiKeys,
  type ProviderApiKeyProbeExecutor,
  type VerifyProviderApiKeyOptions,
} from "./providers/apiKeyAuth.js";
import { resolveAgyAcpAuthPaths } from "./providers/agyAvailability.js";
import { getProviderRuntimeAuthDegradedProviders } from "./providers/runtimeAvailability.js";
import {
  isCursorRouteable,
  resolveCursorAuthPaths,
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
  verifyApiKey?: (provider: ProviderId) => boolean;
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
 * Interactive entrypoints run this through ./interactiveCliAuthStartup.js
 * during module initialization, because they snapshot availability before
 * their own body executes. Merely importing the availability functions (for
 * example from the outward ACP server) has no startup side effect.
 */
export async function prepareInteractiveCliAuthStartup(
  options: InteractiveCliAuthStartupOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  loadInteractiveEnvFile({ env, processEnv: env, ...(options.cwd ? { cwd: options.cwd } : {}) });
  await prepareInteractiveCliAuth(env, options);
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

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `which`-equivalent PATH lookup done in-process. Availability runs on every
 * Workstream status projection, so a subprocess per provider blocked the
 * event loop; the lookup stays fully fresh because nothing is cached. Empty
 * PATH entries are ignored rather than treated as the current directory.
 */
export function commandExistsOnPath(command: string, path = process.env.PATH ?? ""): boolean {
  if (!command) return false;
  if (command.includes("/")) return isExecutableFile(isAbsolute(command) ? command : resolve(command));
  return path.split(delimiter).some((dir) => dir !== "" && isExecutableFile(join(dir, command)));
}

export function getAvailableCliKinds(options: AvailableCliOptions = {}): Set<CliKind> {
  const home = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const commandExists = options.commandExists ?? commandExistsOnPath;
  const env = options.env ?? process.env;
  // Interactive availability is based on direct attempt prerequisites. Current
  // qualification failures stay visible to health/doctor/release owners, but
  // do not suppress an authenticated runnable provider before execution.
  const failedProviders = new Set(options.failedProviders ?? getProviderRuntimeAuthDegradedProviders(home));
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

  // Official Agy sign-in is cached in Google's native secure keyring, not
  // necessarily a readable file. No status-path probe or false-negative OAuth
  // file requirement: attempt ACP when the locked CLI is installed and let
  // its native runtime report authentication failure if disconnected.
  const agyRuntimeReady = options.agyRuntimeReady?.() ?? true;
  if (hasRuntime("agy") && agyRuntimeReady && !failedProviders.has("agy")) {
    available.add("antigravity");
  }

  if (hasRuntime("grok") && isGrokRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
    verifyApiKey: () => verifyApiKey("grok"),
  })) available.add("grok");
  if (hasRuntime("cursor") && isCursorRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
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

/** Existing hot-path entrypoint, now a no-cache alias of inexpensive local reads. */
export const getCachedAvailableCliKinds = getAvailableCliKinds;
