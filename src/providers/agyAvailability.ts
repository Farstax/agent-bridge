import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgyAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

/**
 * The selected antigravity-acp 1.1.1 runtime is a separate credential owner
 * from native Agy/antigravity-cli (`~/.gemini/oauth_creds.json`): it resolves
 * Gemini home to `~/.gemini` and persists its own oauth-personal exchange to
 * `~/.gemini/antigravity-acp/acp_token.json`. A cached native Agy login does
 * not satisfy this.
 */
export function resolveAgyAcpAuthPaths(
  homeDir: string = homedir(),
  env: Record<string, string | undefined> = process.env,
): string[] {
  const geminiHome = env.GEMINI_HOME?.trim() || join(homeDir, ".gemini");
  return [join(geminiHome, "antigravity-acp", "acp_token.json")];
}

/**
 * True only when a cached antigravity-acp OAuth exchange already exists on
 * disk. `authenticate({ methodId: "oauth-personal" })` launches an
 * interactive Google OAuth browser flow when no cached credential exists —
 * Bridge must never trigger that during an ordinary Run, so this must return
 * false (and callers must skip the explicit authenticate RPC entirely) when
 * no cached token is present, rather than optimistically claiming readiness.
 */
export function hasAgyAcpCachedAuth(options: AgyAvailabilityOptions = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;
  return resolveAgyAcpAuthPaths(homeDir, env).some(exists);
}
