import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AgyAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  isExecutable?: (path: string) => boolean;
  isValid?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
}

export const DEFAULT_AGY_HARNESS_PATH = "/usr/local/bin/agy_localharness_external";

export function resolveAgyHarnessPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.ANTIGRAVITY_HARNESS_PATH?.trim() || DEFAULT_AGY_HARNESS_PATH;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function managedHarnessValid(path: string): boolean {
  try {
    const target = realpathSync(path);
    const manifest = JSON.parse(readFileSync(join(dirname(target), "manifest.json"), "utf8")) as {
      schemaVersion?: number;
      harnessName?: string;
      harnessSha256?: string;
    };
    if (manifest.schemaVersion !== 2 || manifest.harnessName !== "localharness_external") return false;
    if (!manifest.harnessSha256?.match(/^[0-9a-f]{64}$/)) return false;
    const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
    return digest === manifest.harnessSha256;
  } catch {
    return false;
  }
}

export function hasAgyRuntimePrerequisites(options: AgyAvailabilityOptions = {}): boolean {
  const env = options.env ?? process.env;
  const path = resolveAgyHarnessPath(env);
  const exists = options.exists ?? existsSync;
  const isExecutable = options.isExecutable ?? executable;
  const isValid = options.isValid ?? managedHarnessValid;
  return exists(path) && isExecutable(path) && isValid(path);
}

export function assertAgyRuntimePrerequisites(
  env: Record<string, string | undefined> = process.env,
): void {
  const path = resolveAgyHarnessPath(env);
  if (!hasAgyRuntimePrerequisites({ env })) {
    throw new Error(
      `Antigravity managed runtime is incomplete: required executable localharness_external is unavailable at ${path}`,
    );
  }
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
