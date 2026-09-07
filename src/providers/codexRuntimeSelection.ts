export type CodexRuntimeKind = "legacy" | "acp";

/**
 * Explicit Codex execution path. There is no silent fallback between the
 * legacy `codex exec` runtime and the ACP-backed runtime inside one attempt.
 */
export function resolveCodexRuntime(
  env: Record<string, string | undefined> = process.env,
): CodexRuntimeKind {
  const raw = (env.AGENT_BRIDGE_CODEX_RUNTIME ?? "legacy").trim().toLowerCase();
  if (raw === "acp") return "acp";
  if (raw === "legacy" || raw === "") return "legacy";
  throw new Error(`Unknown AGENT_BRIDGE_CODEX_RUNTIME: ${raw}. Use "legacy" or "acp".`);
}

export function resolveCodexAcpCommand(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CODEX_ACP_COMMAND?.trim() || "codex-acp";
}

export function resolveCodexAcpArgs(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env.CODEX_ACP_ARGS?.trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

export function isCodexAcpRuntime(
  bot: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return bot === "codex" && resolveCodexRuntime(env) === "acp";
}
