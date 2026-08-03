import { readFileSync } from "node:fs";

const MAX_CONTEXT_CHARS = 8_000;

export function loadWorkspaceContext(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
  if (!file) return "";
  try { return readFileSync(file, "utf8").slice(0, MAX_CONTEXT_CHARS).trim(); }
  catch { return ""; }
}

export function prependWorkspaceContext(prompt: string, env: NodeJS.ProcessEnv = process.env): string {
  const context = loadWorkspaceContext(env);
  return context ? `[Selected workspace repository]\n${context}\n\n${prompt}` : prompt;
}
