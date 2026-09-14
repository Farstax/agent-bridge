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

export function resolveGrokAuthPaths(
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const explicitAuthPath = env.GROK_AUTH_PATH?.trim();
  if (explicitAuthPath) return [explicitAuthPath];
  const grokHome = env.GROK_HOME?.trim() || join(homeDir, ".grok");
  return [join(grokHome, "auth.json")];
}

export function isGrokAuthenticated(options: GrokAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;

  // The selected Grok ACP runtime consumes GROK_AUTH_PATH when explicitly set,
  // otherwise GROK_HOME/auth.json (default ~/.grok/auth.json). Keep account auth
  // authoritative over an optional API key, but do not claim readiness from
  // legacy paths the selected runtime does not consume.
  if (resolveGrokAuthPaths(homeDir, env).some(exists)) return true;
  if (!isProviderApiKeyConfigured("grok", env)) return false;
  return options.verifyApiKey?.() ?? isProviderApiKeyVerified("grok", env);
}

export function isGrokRouteable(options: GrokAvailabilityOptions = {}): boolean {
  if (!isGrokAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  return !failedProviders.has("grok");
}
