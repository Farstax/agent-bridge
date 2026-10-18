import { execFileSync } from "node:child_process";
import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

const DEFAULT_AGY_ACP_COMMAND = "agy_acp_server.par";
const DEFAULT_AGY_ACP_ARGS = ["--uid="];
export const AGY_ACP_VERSION_TIMEOUT_MS = 30_000;

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

export function readAgyAcpVersion(
  command: string,
  execute: typeof execFileSync = execFileSync,
): string {
  return execute(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: AGY_ACP_VERSION_TIMEOUT_MS,
  }).trim();
}

/** Refuse an installed Agy executable whose actual version differs from the release lock. */
export function assertAgyAcpVersion(
  command: string,
  expectedVersion: string | null,
  readVersion: () => string = () => readAgyAcpVersion(command),
): void {
  if (!expectedVersion) throw new Error("Agy ACP release lock has no selected version");
  let observedVersion = "unknown";
  try {
    const raw = readVersion();
    observedVersion = raw.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? "unknown";
  } catch (error) {
    throw new Error(`Agy ACP executable could not be version-verified: ${(error as Error).message}`);
  }
  if (observedVersion !== expectedVersion) {
    throw new Error(`Agy ACP executable version mismatch: release lock expects ${expectedVersion}, observed ${observedVersion}`);
  }
}
