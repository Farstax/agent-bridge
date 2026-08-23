import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderQualificationPassed } from "./qualificationStatus.js";

export interface GrokAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  qualified?: boolean;
}

export function resolveGrokAuthPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".grok", "auth.json"),
    join(homeDir, ".config", "grok", "auth.json"),
  ];
}

export function isGrokAuthenticated(options: GrokAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  return resolveGrokAuthPaths(homeDir).some(exists) || Boolean(env.XAI_API_KEY?.trim());
}

/**
 * Grok is opt-in and fail-closed: credentials are necessary but the exact
 * installed binary must also have current passing provider-qualification evidence.
 */
export function isGrokRouteable(options: GrokAvailabilityOptions = {}): boolean {
  if (!isGrokAuthenticated(options)) return false;
  return options.qualified ?? isProviderQualificationPassed("grok");
}
