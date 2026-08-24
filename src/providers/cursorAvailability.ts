import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getQualificationFailedProviders } from "./qualificationStatus.js";
import type { ProviderId } from "./types.js";

export interface CursorAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  failedProviders?: ReadonlySet<ProviderId>;
}

export function resolveCursorAuthPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".config", "cursor", "auth.json"),
    join(homeDir, ".cursor", "auth.json"),
  ];
}

export function isCursorAuthenticated(options: CursorAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  return resolveCursorAuthPaths(homeDir).some(exists) || Boolean(env.CURSOR_API_KEY?.trim());
}

/**
 * Cursor is routeable when authenticated unless current qualification evidence
 * proves a deterministic failure. Missing/stale/degraded evidence is diagnostic,
 * not a routing prerequisite. Cursor remains opt-in for default chains.
 */
export function isCursorRouteable(options: CursorAvailabilityOptions = {}): boolean {
  if (!isCursorAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  return !failedProviders.has("cursor");
}
