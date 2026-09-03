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
  "BRIDGE_PROJECT_DIR",
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
  try {
    return loadProviderRuntimeEnvironment(providerId, {
      directory: options.directory,
      baseEnv: operationalBase,
    });
  } catch (error) {
    // A required file can exist but be unreadable by this process — e.g. the
    // real upgrade.sh flow deliberately runs the qualifier as the
    // unprivileged target user (for provider auth) while the root-owned
    // service files stay 600. That process can no more independently
    // re-derive the service policy from disk than one facing an absent
    // file, so it falls back the same way: trust ambient env.
    if ((error as NodeJS.ErrnoException).code === "EACCES") return { ...ambientEnv };
    throw error;
  }
}

/** Replace a qualifier process environment with the resolved service environment. */
export function applyQualificationEntrypointEnvironment(
  env: ProviderRuntimeEnv,
  target: NodeJS.ProcessEnv = process.env,
): void {
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) delete target[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}
