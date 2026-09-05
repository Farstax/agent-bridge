import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export interface InteractiveEnvLoadResult {
  path: string;
  loaded: boolean;
}

export function resolveInteractiveEnvPath(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.BRIDGE_ENV_FILE?.trim();
  return resolve(cwd, configured || ".env.interactive");
}

/**
 * Load the same interactive env file used by the Telegram runtime without
 * replacing values already supplied by the process environment.
 */
export function loadInteractiveEnv(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): InteractiveEnvLoadResult {
  const path = resolveInteractiveEnvPath(env, cwd);
  if (!existsSync(path)) return { path, loaded: false };

  const parsed = dotenv.parse(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return { path, loaded: true };
}
