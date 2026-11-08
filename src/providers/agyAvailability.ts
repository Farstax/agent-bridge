import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgyAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

/** Official CLI sign-in is independent of the old .par OAuth token. */
export function resolveAgyAcpAuthPaths(
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const geminiHome = env.GEMINI_HOME?.trim() || join(homeDir, ".gemini");
  return [join(geminiHome, "oauth_creds.json")];
}

export function hasAgyAcpCachedAuth(options: AgyAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  return resolveAgyAcpAuthPaths(homeDir, env).some(exists);
}
