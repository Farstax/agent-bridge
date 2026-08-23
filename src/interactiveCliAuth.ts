import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
import { isGrokRouteable, resolveGrokAuthPaths } from "./providers/grokAvailability.js";
import type { ProviderId } from "./providers/types.js";

export interface InteractiveCliAuthPaths {
  codex: string;
  claude: string;
  antigravity: string[];
  grok: string[];
}

export interface AvailableCliOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  commandExists?: (command: string) => boolean;
  failedProviders?: ReadonlySet<ProviderId>;
  env?: Record<string, string | undefined>;
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

  if (exists(paths.codex) && !failedProviders.has("codex")) available.add("codex");
  if (exists(paths.claude) && !failedProviders.has("claude")) available.add("claude");
  if (paths.antigravity.some(exists) && !failedProviders.has("agy")) available.add("antigravity");

  if (isGrokRouteable({ homeDir: home, exists, env, failedProviders })) available.add("grok");

  void commandExists; // retained for the existing injectable availability seam.
  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
