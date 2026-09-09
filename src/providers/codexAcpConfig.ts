import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBridgeProjectDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.BRIDGE_PROJECT_DIR?.trim();
  if (configured) return configured;
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function bundledCodexAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(resolveBridgeProjectDir(env), "node_modules", ".bin", "codex-acp");
}

export function resolveCodexAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CODEX_ACP_COMMAND?.trim() || bundledCodexAcpCommand(env);
}

export function resolveCodexAcpArgs(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CODEX_ACP_ARGS?.trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}
