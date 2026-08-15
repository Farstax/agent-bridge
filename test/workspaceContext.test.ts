import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaceContext, prependWorkspaceContext } from "../src/workspaceContext.js";

describe("workspace context", () => {
  it("loads the platform-owned repository context without exposing unrelated environment values", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\n");
    try {
      expect(loadWorkspaceContext({ AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file, GITHUB_TOKEN: "secret" })).toContain("owner/repo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("includes only the canonical shared skills root and SKILL.md convention", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\n");
    try {
      const context = loadWorkspaceContext({
        AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file,
        HOME: "/home/agentbridge",
      });
      expect(context).toContain("/home/agentbridge/.agents/skills");
      expect(context).toContain("<shared-skills-root>/<skill-name>/SKILL.md");
      expect(context).not.toContain(".skill-lock.json");
      expect(context).not.toContain("/home/agentbridge/.codex/skills");
      expect(context).not.toContain("/home/agentbridge/.claude/skills");
      expect(context).not.toContain("/home/agentbridge/.gemini/antigravity-cli/skills");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps shared skill discovery visible within the workspace-context size bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "x".repeat(20_000));
    try {
      const context = loadWorkspaceContext({
        AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file,
        SHARED_MEMORY_HOME: "/srv/agent-bridge-home",
      });
      expect(context.length).toBeLessThanOrEqual(8_000);
      expect(context).toContain("/srv/agent-bridge-home/.agents/skills");
      expect(context).toContain("<shared-skills-root>/<skill-name>/SKILL.md");
      expect(context).not.toContain(".skill-lock.json");
      expect(context).not.toContain("/.codex/skills");
      expect(context).not.toContain("/.claude/skills");
      expect(context).not.toContain("/.gemini/antigravity-cli/skills");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails open with an empty string when no context file is configured", () => {
    expect(loadWorkspaceContext({})).toBe("");
    expect(prependWorkspaceContext("Please inspect the repository", {})).toBe("Please inspect the repository");
  });

  it("fails open with an empty string when the configured context file is unreadable", () => {
    const missingFile = join(mkdtempSync(join(tmpdir(), "workspace-context-")), "does-not-exist.md");
    expect(loadWorkspaceContext({ AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: missingFile })).toBe("");
    expect(prependWorkspaceContext("Please inspect the repository", { AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: missingFile }))
      .toBe("Please inspect the repository");
  });

  it("prepends managed context without copying environment secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\nDefault branch: main\n");
    try {
      const prompt = prependWorkspaceContext("Please inspect the repository", { AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file, GITHUB_TOKEN: "secret" });
      expect(prompt).toContain("Repository: owner/repo");
      expect(prompt).toContain("Please inspect the repository");
      expect(prompt).not.toContain("GITHUB_TOKEN");
      expect(prompt).not.toContain("secret");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
