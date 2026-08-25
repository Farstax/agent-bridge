import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderApiKeyConfigured, isProviderApiKeyVerified } from "./apiKeyAuth.js";
import { getQualificationFailedProviders } from "./qualificationStatus.js";
import type { ProviderId } from "./types.js";

export interface GrokAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  failedProviders?: ReadonlySet<ProviderId>;
  verifyApiKey?: () => boolean;
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

  // Grok Build gives an active account session precedence over XAI_API_KEY.
  // Preserve that provider-owned account path unchanged when it exists.
  if (resolveGrokAuthPaths(homeDir).some(exists)) return true;
  if (!isProviderApiKeyConfigured("grok", env)) return false;
  return options.verifyApiKey?.() ?? isProviderApiKeyVerified("grok", env);
}

export function isGrokRouteable(options: GrokAvailabilityOptions = {}): boolean {
  if (!isGrokAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  return !failedProviders.has("grok");
}
