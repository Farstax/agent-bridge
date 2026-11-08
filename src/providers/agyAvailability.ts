import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgyAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * Native agy CLI authentication is separate from legacy antigravity-acp.
 * Include the old token only for diagnostics/visible existing connection
 * state; the official CLI itself decides whether sign-in is usable.
 */
export function resolveAgyAcpAuthPaths(
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const geminiHome = env.GEMINI_HOME?.trim() || join(homeDir, ".gemini");
  return [
    join(geminiHome, "oauth_creds.json"),
    join(geminiHome, "antigravity-acp", "acp_token.json"),
  ];
}

export function hasAgyAcpCachedAuth(options: AgyAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  return resolveAgyAcpAuthPaths(homeDir, env).some(exists);
}
