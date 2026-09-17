import { createHash } from "node:crypto";
import { resolve } from "node:path";

type Env = Record<string, string | undefined>;

const CUSTOM_ACP_CONFIG_KEYS = [
  "CUSTOM_ACP_COMMAND",
  "CUSTOM_ACP_ARGS_JSON",
  "CUSTOM_ACP_AUTH_METHOD_ID",
] as const;

export interface ExternalAcpLaunchConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly authMethodId?: string;
  readonly runtimeIdentity: string;
}

export function hasCustomAcpConfiguration(env: Env = process.env): boolean {
  return CUSTOM_ACP_CONFIG_KEYS.some((key) => env[key] !== undefined);
}

export function resolveCustomAcpWorkingDir(
  env: Env = process.env,
  processCwd: string = process.cwd(),
): string {
  const configured = env.CUSTOM_ACP_PROJECT_DIR?.trim()
    || env.BRIDGE_PROJECT_DIR?.trim()
    || env.BRIDGE_ROOT_DIR?.trim();
  return resolve(processCwd, configured || ".");
}

function parseArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid CUSTOM_ACP_ARGS_JSON: expected a JSON string array");
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error("Invalid CUSTOM_ACP_ARGS_JSON: expected a JSON string array");
  }
  return [...parsed];
}

export function resolveCustomAcpLaunch(
  env: Env = process.env,
): ExternalAcpLaunchConfig | null {
  if (!hasCustomAcpConfiguration(env)) return null;

  const command = env.CUSTOM_ACP_COMMAND?.trim();
  if (!command) {
    throw new Error("CUSTOM_ACP_COMMAND is required when custom ACP is configured");
  }

  const args = parseArgs(env.CUSTOM_ACP_ARGS_JSON);
  const authMethodId = env.CUSTOM_ACP_AUTH_METHOD_ID?.trim() || undefined;
  const workingDir = resolveCustomAcpWorkingDir(env);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ command, args, authMethodId: authMethodId ?? null, workingDir }))
    .digest("hex");

  return {
    command,
    args,
    ...(authMethodId ? { authMethodId } : {}),
    runtimeIdentity: `custom-acp:${fingerprint}`,
  };
}