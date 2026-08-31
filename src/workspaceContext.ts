import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSharedSkillsHomeDir, resolveSkillPaths } from "./skills.js";

const MAX_CONTEXT_CHARS = 8_000;

function skillsContext(env: NodeJS.ProcessEnv): string {
  const paths = resolveSkillPaths(getSharedSkillsHomeDir(env));
  return [
    "## Agent Bridge skills",
    "",
    `- Shared skills root: \`${paths.agentsSkillsDir}\``,
    "- Each installed skill has instructions at `<shared-skills-root>/<skill-name>/SKILL.md`; inspect and follow relevant skills before starting work.",
  ].join("\n");
}

export function runtimeInspectorContext(env: NodeJS.ProcessEnv = process.env, repoRoot = process.cwd()): string {
  if (!env.DB_PATH && !env.AGENT_BRIDGE_CONTEXT_DB && env.NODE_ENV !== "production") return "";
  const command = join(repoRoot, "bin", "agent-bridge-inspect");
  if (!existsSync(command)) return "";
  return [
    "[Agent Bridge runtime]",
    `Read-only runtime state and capabilities: \`${command} --json\``,
    `Capabilities only: \`${command} capabilities --json\``,
    "The inspector is a projection only; it does not grant mutation authority.",
  ].join("\n");
}

export function loadWorkspaceContext(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
  if (!file) return "";
  try {
    const skills = skillsContext(env);
    const separator = "\n\n";
    const availableFileChars = Math.max(0, MAX_CONTEXT_CHARS - skills.length - separator.length);
    const workspace = readFileSync(file, "utf8").slice(0, availableFileChars).trim();
    return [workspace, skills].filter(Boolean).join(separator).slice(0, MAX_CONTEXT_CHARS);
  } catch {
    return "";
  }
}

export function prependWorkspaceContext(prompt: string, env: NodeJS.ProcessEnv = process.env): string {
  const managed = loadWorkspaceContext(env);
  const inspector = runtimeInspectorContext(env);
  const context = [
    managed ? `[Managed workspace context]\n${managed}` : "",
    inspector,
  ].filter(Boolean).join("\n\n");
  return context ? `${context}\n\n${prompt}` : prompt;
}
