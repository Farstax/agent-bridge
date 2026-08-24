import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyVerified,
  verifyConfiguredProviderApiKeys,
} from "./providers/apiKeyAuth.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
import {
  isCursorRouteable,
  resolveCursorAuthPaths,
  type CursorStatusSnapshot,
} from "./providers/cursorAvailability.js";
import { isGrokRouteable, resolveGrokAuthPaths } from "./providers/grokAvailability.js";
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

const primedApiKeyEnvironments = new WeakSet<object>();

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

  // Key verification is deliberately detached from this synchronous routing
  // check. The first availability pass primes bounded probes; later passes use
  // only cached evidence, so a provider request never blocks the Node event loop.
  if (!options.verifyApiKey && !primedApiKeyEnvironments.has(env)) {
    primedApiKeyEnvironments.add(env);
    void verifyConfiguredProviderApiKeys({ env });
  }
  const verifyApiKey = options.verifyApiKey ?? ((provider: ProviderId) =>
    isProviderApiKeyVerified(provider, env));

  const codexAuthenticated = exists(paths.codex)
    || (isProviderApiKeyConfigured("codex", env) && verifyApiKey("codex"));
  if (codexAuthenticated && !failedProviders.has("codex")) available.add("codex");

  const claudeAuthenticated = exists(paths.claude)
    || (isProviderApiKeyConfigured("claude", env) && verifyApiKey("claude"));
  if (claudeAuthenticated && !failedProviders.has("claude")) available.add("claude");

  const agyAuthenticated = paths.antigravity.some(exists)
    || (isProviderApiKeyConfigured("agy", env) && verifyApiKey("agy"));
  if (agyAuthenticated && !failedProviders.has("agy")) available.add("antigravity");

  if (isGrokRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
    verifyApiKey: () => verifyApiKey("grok"),
  })) available.add("grok");
  if (isCursorRouteable({
    homeDir: home,
    exists,
    env,
    failedProviders,
    readStatus: options.readCursorStatus,
    verifyApiKey: () => verifyApiKey("cursor"),
  })) available.add("cursor");

  void commandExists; // retained for the existing injectable availability seam.
  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
