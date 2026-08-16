import { readFileSync } from "node:fs";
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
  const context = loadWorkspaceContext(env);
  return context ? `[Managed workspace context]\n${context}\n\n${prompt}` : prompt;
}
