import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderApiKeyConfigured, isProviderApiKeyVerified } from "./apiKeyAuth.js";
import { getProviderRuntimeAuthDegradedProviders } from "./runtimeAvailability.js";
import type { ProviderId } from "./types.js";

export interface CursorAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  failedProviders?: ReadonlySet<ProviderId>;
  verifyApiKey?: () => boolean;
}

export function resolveCursorAuthPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".config", "cursor", "auth.json"),
    join(homeDir, ".cursor", "auth.json"),
  ];
}

/**
 * Routing checks cheap account-session prerequisites or a previously verified
 * API key. File presence does not prove a successful sign-in; ACP execution
 * remains authoritative. Do not spawn native Cursor status commands.
 */
export function isCursorAuthenticated(options: CursorAvailabilityOptions = {}): boolean {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  if (resolveCursorAuthPaths(options.homeDir ?? homedir()).some(exists)) return true;
  return isProviderApiKeyConfigured("cursor", env)
    && (options.verifyApiKey?.() ?? isProviderApiKeyVerified("cursor", env));
}

/**
 * Cursor ACP version validation stays in cursorAcpPolicy.validateRuntime on
 * actual execution, never on routine Workstream status or chain discovery.
 */
export function isCursorRouteable(options: CursorAvailabilityOptions = {}): boolean {
  if (!isCursorAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getProviderRuntimeAuthDegradedProviders(options.homeDir);
  return !failedProviders.has("cursor");
}
