import { existsSync } from "node:fs";
import type { ProviderId } from "./types.js";
import {
  loadProviderRuntimeEnvironment,
  providerRuntimeEnvironmentFiles,
  type ProviderRuntimeEnv,
} from "./runtimeEnvironment.js";

const OPERATIONAL_ENV_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "AGENT_BRIDGE_PROVIDER_QUALIFICATION_PATH",
] as const;

export interface QualificationEntrypointEnvironmentOptions {
  directory?: string;
  ambientEnv?: ProviderRuntimeEnv;
}

/**
 * Resolve the effective environment used by the provider service.
 *
 * On a managed/systemd installation, required release/provider files are the
 * authority; the caller shell contributes only operational process variables.
 * On a development checkout without those service files, the ambient
 * environment remains the explicit local fallback.
 */
export function resolveQualificationEntrypointEnvironment(
  providerId: ProviderId,
  options: QualificationEntrypointEnvironmentOptions = {},
): ProviderRuntimeEnv {
  const ambientEnv = options.ambientEnv ?? process.env;
  const files = providerRuntimeEnvironmentFiles(providerId, options.directory);
  const requiredFilesPresent = files.filter((file) => !file.optional).every((file) => existsSync(file.path));
  if (!requiredFilesPresent) return { ...ambientEnv };

  const operationalBase: ProviderRuntimeEnv = {};
  for (const key of OPERATIONAL_ENV_KEYS) {
    if (ambientEnv[key] !== undefined) operationalBase[key] = ambientEnv[key];
  }
  return loadProviderRuntimeEnvironment(providerId, {
    directory: options.directory,
    baseEnv: operationalBase,
  });
}
