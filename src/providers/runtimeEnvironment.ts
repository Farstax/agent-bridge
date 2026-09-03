import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { ProviderId } from "./types.js";

export type ProviderRuntimeEnv = Record<string, string | undefined>;

export interface ProviderRuntimeEnvironmentFile {
  path: string;
  optional: boolean;
}

function providerServiceName(providerId: ProviderId): string {
  return providerId === "agy" ? "antigravity" : providerId;
}

/**
 * Ordered EnvironmentFile inputs used by the provider systemd services.
 * Later files override earlier files, matching systemd EnvironmentFile order.
 */
export function providerRuntimeEnvironmentFiles(
  providerId: ProviderId,
  directory = "/etc/default",
): ProviderRuntimeEnvironmentFile[] {
  return [
    { path: join(directory, "agent-bridge-shared"), optional: true },
    { path: join(directory, "agent-bridge-release"), optional: false },
    { path: join(directory, `agent-bridge-${providerServiceName(providerId)}`), optional: false },
  ];
}

export interface LoadProviderRuntimeEnvironmentOptions {
  directory?: string;
  baseEnv?: ProviderRuntimeEnv;
}

/**
 * Load the OSS-owned provider service environment without logging values.
 *
 * `baseEnv` is an explicit injection hook for tests/callers. Service files are
 * applied after it in unit order, so shared < release < provider-specific.
 */
export function loadProviderRuntimeEnvironment(
  providerId: ProviderId,
  options: LoadProviderRuntimeEnvironmentOptions = {},
): ProviderRuntimeEnv {
  const env: ProviderRuntimeEnv = { ...(options.baseEnv ?? {}) };
  for (const file of providerRuntimeEnvironmentFiles(providerId, options.directory)) {
    if (!existsSync(file.path)) {
      if (file.optional) continue;
      throw new Error(`provider runtime environment file is missing: ${file.path}`);
    }
    const parsed = parseEnv(readFileSync(file.path, "utf8"));
    Object.assign(env, parsed);
  }
  return env;
}
