import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./interactiveBot.js";
import { getQualificationFailedProviders, isProviderQualificationPassed } from "./providers/qualificationStatus.js";
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
  qualifiedProviders?: ReadonlySet<ProviderId>;
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
  const env = options.env ?? process.env;
  const paths = resolveInteractiveCliAuthPaths(home);
  const available = new Set<CliKind>();

  if (exists(paths.codex) && !failedProviders.has("codex")) available.add("codex");
  if (exists(paths.claude) && !failedProviders.has("claude")) available.add("claude");
  if (paths.antigravity.some(exists) && !failedProviders.has("agy")) available.add("antigravity");

  // Grok is deliberately stricter than established providers: registration is
  // opt-in and routing stays fail-closed until this exact installed binary has
  // a current passing provider-qualification record. Do not probe provider
  // versions at all unless Grok authentication is present.
  const grokAuthenticated = paths.grok.some(exists) || Boolean(env.XAI_API_KEY?.trim());
  const grokQualified = grokAuthenticated && (
    options.qualifiedProviders
      ? options.qualifiedProviders.has("grok")
      : isProviderQualificationPassed("grok")
  );
  if (grokQualified && !failedProviders.has("grok")) available.add("grok");

  void commandExists; // retained for the existing injectable availability seam.
  return available;
}

export const getAuthenticatedCliKinds = getAvailableCliKinds;
