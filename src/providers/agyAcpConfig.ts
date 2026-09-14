import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

const DEFAULT_AGY_ACP_COMMAND = "agy_acp_server.par";
const DEFAULT_AGY_ACP_ARGS = ["--uid="];

export function resolveAgyAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.AGY_ACP_COMMAND?.trim() || DEFAULT_AGY_ACP_COMMAND;
}

export function resolveAgyAcpArgs(
  env: Record<string, string | undefined> = process.env,
  entry?: AcpRegistryAgentEntry,
): string[] {
  const raw = env.AGY_ACP_ARGS;
  if (raw !== undefined) {
    return raw.trim().split(/\s+/).filter(Boolean);
  }
  return [...(entry?.distribution.binary?.["linux-x86_64"]?.args ?? DEFAULT_AGY_ACP_ARGS)];
}
