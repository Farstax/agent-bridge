import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

/** Official grok-build ACP server is the Grok CLI over `agent stdio`, not a bundled adapter package. */
export function resolveGrokAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.GROK_ACP_COMMAND?.trim() || "grok";
}

export function resolveGrokAcpArgs(
  env: Record<string, string | undefined> = process.env,
  entry?: AcpRegistryAgentEntry,
): string[] {
  if (env.GROK_ACP_ARGS !== undefined) {
    return env.GROK_ACP_ARGS.trim().split(/\s+/).filter(Boolean);
  }
  return [...(entry?.distribution.npx?.args ?? ["agent", "stdio"])];
}
