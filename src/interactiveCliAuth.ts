import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import { getQualificationFailedProviders } from "./providers/qualificationStatus.js";
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
}

export function resolveInteractiveCliAuthPaths(homeDir: string = homedir()): InteractiveCliAuthPaths {
  return {
    codex: join(homeDir, ".codex", "auth.json"),
    claude: join(homeDir, ".claude", ".credentials.json"),
    antigravity: [
      join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      join(homeDir, ".gemini", "oauth_creds.json"),
    ],
    grok: [
      join(homeDir, ".grok", "auth.json"),
      join(homeDir, ".config", "grok", "auth.json"),
    ],
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
  const paths = resolveInteractiveCliAuthPaths(home);
  const available = new Set<CliKind>();

  if (exists(paths.codex) && !failedProviders.has("codex")) available.add("codex");
  if (exists(paths.claude) && !failedProviders.has("claude")) available.add("claude");
  if (paths.antigravity.some(exists) && !failedProviders.has("agy")) available.add("antigravity");
  if (paths.grok.some(exists) && !failedProviders.has("grok")) available.add("grok");

  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
