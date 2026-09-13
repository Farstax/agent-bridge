import { join } from "node:path";
import { resolveBridgeProjectDir } from "./acpConfig.js";
import type { AcpRegistryAgentEntry } from "./acpRegistry.js";

export function bundledGrokAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveBridgeProjectDir(env), "node_modules", ".bin", "grok");
}

export function resolveGrokAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.GROK_ACP_COMMAND?.trim() || bundledGrokAcpCommand(env);
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
