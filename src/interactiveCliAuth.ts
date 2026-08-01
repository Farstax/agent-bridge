import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";

export interface InteractiveCliAuthPaths {
  codex: string;
  claude: string;
  antigravity: string[];
}

export interface AvailableCliOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  commandExists?: (command: string) => boolean;
}

export function resolveInteractiveCliAuthPaths(homeDir: string = homedir()): InteractiveCliAuthPaths {
  return {
    codex: join(homeDir, ".codex", "auth.json"),
    claude: join(homeDir, ".claude", ".credentials.json"),
    antigravity: [
      join(homeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
      join(homeDir, ".gemini", "oauth_creds.json"),
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
  const paths = resolveInteractiveCliAuthPaths(home);
  const available = new Set<CliKind>();

  if (exists(paths.codex)) available.add("codex");
  if (exists(paths.claude)) available.add("claude");
  if (paths.antigravity.some(exists)) available.add("antigravity");
  if (commandExists("kimchi")) available.add("kimchi");

  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
