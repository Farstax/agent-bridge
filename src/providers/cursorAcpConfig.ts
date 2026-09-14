import { execFileSync } from "node:child_process";
import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

/** Exact Cursor binary build selected by the Registry archive lock. */
export const CURSOR_ACP_VERSION = "2026.09.08-6caf4ff";

export function resolveCursorAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CURSOR_ACP_COMMAND?.trim() || "cursor-agent";
}

export function resolveCursorAcpArgs(
  env: Record<string, string | undefined> = process.env,
  entry?: AcpRegistryAgentEntry,
): string[] {
  if (env.CURSOR_ACP_ARGS !== undefined) {
    return env.CURSOR_ACP_ARGS.trim().split(/\s+/).filter(Boolean);
  }
  return [...(entry?.distribution.binary?.["linux-x86_64"]?.args ?? ["acp"])];
}

export function normalizeCursorAcpVersion(raw: string): string {
  const match = raw.trim().match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? raw.trim();
}

export function readCursorAcpVersion(
  command: string,
  execFile: typeof execFileSync = execFileSync,
): string {
  const raw = execFile(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
  if (!raw) throw new Error("Cursor ACP version command returned no output");
  return normalizeCursorAcpVersion(raw);
}

export function assertCursorAcpVersion(
  command: string,
  readVersion: () => string = () => readCursorAcpVersion(command),
): void {
  let observed: string;
  try {
    observed = normalizeCursorAcpVersion(readVersion());
  } catch (error) {
    throw new Error(`Cursor ACP executable could not be version-verified: ${(error as Error).message}`);
  }
  if (observed !== CURSOR_ACP_VERSION) {
    throw new Error(
      `Cursor ACP executable version mismatch: release lock expects ${CURSOR_ACP_VERSION}, observed ${observed || "unknown"}`,
    );
  }
}
