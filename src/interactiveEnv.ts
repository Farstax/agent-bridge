import { isAbsolute, resolve } from "node:path";
import dotenv from "dotenv";

export interface InteractiveEnvLoadOptions {
  env?: NodeJS.ProcessEnv;
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function resolveInteractiveEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const configured = env.BRIDGE_ENV_FILE?.trim() || ".env.interactive";
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function loadInteractiveEnvFile(options: InteractiveEnvLoadOptions = {}): string {
  const env = options.env ?? process.env;
  const processEnv = options.processEnv ?? process.env;
  const path = resolveInteractiveEnvFile(env, options.cwd ?? process.cwd());
  dotenv.config({ path, override: false, processEnv });
  return path;
}
