import { readFileSync } from "node:fs";
import { getSharedSkillsHomeDir, resolveSkillPaths } from "./skills.js";

const MAX_CONTEXT_CHARS = 8_000;

function skillLocationsContext(env: NodeJS.ProcessEnv): string {
  const paths = resolveSkillPaths(getSharedSkillsHomeDir(env));
  return [
    "## Agent Bridge skills",
    "",
    `- Shared skills root: \`${paths.agentsSkillsDir}\``,
    `- Skill lockfile: \`${paths.lockfilePath}\``,
    `- Codex skills: \`${paths.codexSkillsDir}\``,
    `- Claude Code skills: \`${paths.claudeSkillsDir}\``,
    `- Antigravity/Agy skills: \`${paths.geminiSkillsDir}\``,
    "- Each installed skill has instructions at `<skill-root>/<skill-name>/SKILL.md`; inspect and follow relevant skills before starting work.",
  ].join("\n");
}

export function loadWorkspaceContext(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
  if (!file) return "";
  try {
    const skills = skillLocationsContext(env);
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
  return context ? `[Selected workspace repository]\n${context}\n\n${prompt}` : prompt;
}
