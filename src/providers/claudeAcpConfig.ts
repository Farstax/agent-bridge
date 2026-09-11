import { join } from "node:path";
import { resolveBridgeProjectDir } from "./codexAcpConfig.js";

export function bundledClaudeAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveBridgeProjectDir(env), "node_modules", ".bin", "claude-agent-acp");
}

export function resolveClaudeAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CLAUDE_ACP_COMMAND?.trim() || bundledClaudeAcpCommand(env);
}

export function resolveClaudeAcpArgs(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CLAUDE_ACP_ARGS?.trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}
