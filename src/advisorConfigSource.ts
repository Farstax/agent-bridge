import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ADVISOR_CONFIG_KEYS = [
  "BRIDGE_ADVISOR_ENABLED",
  "BRIDGE_ADVISOR_MODE",
  "BRIDGE_ADVISOR_CHAIN",
  "BRIDGE_ADVISOR_MAX_CALLS_PER_TURN",
  "BRIDGE_ADVISOR_MAX_CALLS_PER_TASK",
  "BRIDGE_ADVISOR_TIMEOUT_MS",
  "BRIDGE_ADVISOR_CONTEXT_MAX_CHARS",
] as const;

type AdvisorConfigKey = typeof ADVISOR_CONFIG_KEYS[number];
type Env = Record<string, string | undefined>;
type AdvisorFileValues = Partial<Record<AdvisorConfigKey, string>>;

export interface AdvisorConfigSourceDiagnostics {
  repoEnvPath: string;
  systemdEnvPath: string;
  repoReadable: boolean;
  systemdReadable: boolean;
  effectiveChainSource: string;
  effectiveChainMatches: string[];
  driftKeys: AdvisorConfigKey[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readAdvisorEnvFile(path: string): AdvisorFileValues | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const values: AdvisorFileValues = {};
  const allowed = new Set<string>(ADVISOR_CONFIG_KEYS);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!allowed.has(key)) continue;
    values[key as AdvisorConfigKey] = unquote(line.slice(separator + 1));
  }
  return values;
}

export function inspectAdvisorConfigSources({
  env = process.env,
  repoEnvPath,
  systemdEnvPath,
}: {
  env?: Env;
  repoEnvPath?: string;
  systemdEnvPath?: string;
} = {}): AdvisorConfigSourceDiagnostics {
  const resolvedRepoPath = repoEnvPath
    ?? env.BRIDGE_ADVISOR_REPO_ENV_FILE
    ?? join(env.BRIDGE_PROJECT_DIR || process.cwd(), ".env.shared");
  const resolvedSystemdPath = systemdEnvPath
    ?? env.BRIDGE_ADVISOR_SYSTEMD_ENV_FILE
    ?? "/etc/default/agent-bridge-shared";

  const repoValues = readAdvisorEnvFile(resolvedRepoPath);
  const systemdValues = readAdvisorEnvFile(resolvedSystemdPath);
  const effectiveChainConfigured = env.BRIDGE_ADVISOR_CHAIN !== undefined;
  const effectiveChain = (env.BRIDGE_ADVISOR_CHAIN ?? "").trim();

  const effectiveChainMatches: string[] = [];
  if (effectiveChainConfigured) {
    if (systemdValues?.BRIDGE_ADVISOR_CHAIN === effectiveChain) {
      effectiveChainMatches.push(resolvedSystemdPath);
    }
    if (repoValues?.BRIDGE_ADVISOR_CHAIN === effectiveChain) {
      effectiveChainMatches.push(resolvedRepoPath);
    }
  }

  const driftKeys = repoValues && systemdValues
    ? ADVISOR_CONFIG_KEYS.filter((key) => (repoValues[key] ?? "") !== (systemdValues[key] ?? ""))
    : [];

  return {
    repoEnvPath: resolvedRepoPath,
    systemdEnvPath: resolvedSystemdPath,
    repoReadable: repoValues !== null,
    systemdReadable: systemdValues !== null,
    effectiveChainSource: effectiveChainConfigured
      ? "process environment (origin not retained)"
      : "built-in default / unconfigured",
    effectiveChainMatches,
    driftKeys,
  };
}
