import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

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
