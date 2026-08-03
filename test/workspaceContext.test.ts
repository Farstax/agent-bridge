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

  it("includes shared and provider-native skill locations from the runtime home", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\n");
    try {
      const context = loadWorkspaceContext({
        AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file,
        HOME: "/home/agentbridge",
      });
      expect(context).toContain("/home/agentbridge/.agents/skills");
      expect(context).toContain("/home/agentbridge/.agents/.skill-lock.json");
      expect(context).toContain("/home/agentbridge/.codex/skills");
      expect(context).toContain("/home/agentbridge/.claude/skills");
      expect(context).toContain("/home/agentbridge/.gemini/antigravity/skills");
      expect(context).toContain("<skill-root>/<skill-name>/SKILL.md");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps skill discovery visible within the workspace-context size bound", () => {
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
      expect(context).toContain("/srv/agent-bridge-home/.codex/skills");
      expect(context).toContain("/srv/agent-bridge-home/.claude/skills");
      expect(context).toContain("/srv/agent-bridge-home/.gemini/antigravity/skills");
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
