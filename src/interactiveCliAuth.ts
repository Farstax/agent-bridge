import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import type { CliKind } from "./interactiveBot.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyVerified,
  verifyConfiguredProviderApiKeys,
  type ProviderApiKeyProbeExecutor,
} from "./providers/apiKeyAuth.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
import {
  isCursorRouteable,
  resolveCursorAuthPaths,
  type CursorStatusSnapshot,
} from "./providers/cursorAvailability.js";
import { isGrokRouteable, resolveGrokAuthPaths } from "./providers/grokAvailability.js";
import { resolveProviderExecutable } from "./providers/registry.js";
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
  failedProviders?: ReadonlySet<ProviderId>;
  env?: Record<string, string | undefined>;
  readCursorStatus?: () => CursorStatusSnapshot;
  verifyApiKey?: (provider: ProviderId) => boolean;
}

/**
 * Establish bounded native API-key evidence before the interactive runtime
 * makes its first synchronous routing decision. Tests may inject the probe
 * executor; production uses the provider CLIs.
 */
export async function prepareInteractiveCliAuth(
  env: Record<string, string | undefined> = process.env,
  execFile?: ProviderApiKeyProbeExecutor,
): Promise<void> {
  await verifyConfiguredProviderApiKeys({ env, ...(execFile ? { execFile } : {}) });
}

// index-interactive imports this module before its own body executes. Load the
// same env file here and complete configured-key verification during module
// initialization so the first availability snapshot cannot race the probe.
if (process.env.NODE_ENV !== "test") {
  dotenv.config({
    path: process.env.BRIDGE_ENV_FILE || ".env.interactive",
    override: false,
  });
  await prepareInteractiveCliAuth(process.env);
}

export function resolveInteractiveCliAuthPaths(homeDir: string = homedir()): InteractiveCliAuthPaths {
  return {
    codex: join(homeDir, ".codex", "auth.json"),
    claude: join(homeDir, ".claude", ".credentials.json"),
    antigravity: [
      join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      join(homeDir, ".gemini", "oauth_creds.json"),
    ],
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
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  const env = options.env ?? process.env;
  const paths = resolveInteractiveCliAuthPaths(home);
  const available = new Set<CliKind>();
  const verifyApiKey = options.verifyApiKey ?? ((provider: ProviderId) =>
    isProviderApiKeyVerified(provider, env));
  const hasRuntime = (provider: ProviderId): boolean =>
    commandExists(resolveProviderExecutable(provider, env));

  const codexAuthenticated = exists(paths.codex)
    || (isProviderApiKeyConfigured("codex", env) && verifyApiKey("codex"));
  if (codexAuthenticated && hasRuntime("codex") && !failedProviders.has("codex")) available.add("codex");

  const claudeAuthenticated = exists(paths.claude)
    || (isProviderApiKeyConfigured("claude", env) && verifyApiKey("claude"));
  if (claudeAuthenticated && hasRuntime("claude") && !failedProviders.has("claude")) available.add("claude");

  const agyAuthenticated = paths.antigravity.some(exists)
    || (isProviderApiKeyConfigured("agy", env) && verifyApiKey("agy"));
  if (agyAuthenticated && hasRuntime("agy") && !failedProviders.has("agy")) available.add("antigravity");

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
    readStatus: options.readCursorStatus,
    verifyApiKey: () => verifyApiKey("cursor"),
  })) available.add("cursor");

  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
