import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getQualificationFailedProviders } from "./qualificationStatus.js";
import type { ProviderId } from "./types.js";

export interface GrokAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  failedProviders?: ReadonlySet<ProviderId>;
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
 * Grok is routeable when authenticated unless current qualification evidence
 * proves a deterministic failure. Missing/stale/degraded evidence is diagnostic,
 * not a routing prerequisite.
 */
export function isGrokRouteable(options: GrokAvailabilityOptions = {}): boolean {
  if (!isGrokAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  return !failedProviders.has("grok");
}
