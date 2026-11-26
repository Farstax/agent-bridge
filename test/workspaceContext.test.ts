import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextSourcesSignpost, loadWorkspaceContext, prependWorkspaceContext } from "../src/workspaceContext.js";

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

  it("fails open with an empty string when no context file is configured and no Skill is installed", () => {
    const home = mkdtempSync(join(tmpdir(), "workspace-context-home-"));
    try {
      expect(loadWorkspaceContext({ HOME: home })).toBe("");
      expect(prependWorkspaceContext("Please inspect the repository", { HOME: home })).toBe("Please inspect the repository");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("points every provider at installed shared Skills even without a workspace context file", () => {
    const home = mkdtempSync(join(tmpdir(), "workspace-context-home-"));
    mkdirSync(join(home, ".agents/skills/farstax-workspace"), { recursive: true });
    writeFileSync(join(home, ".agents/skills/farstax-workspace/SKILL.md"), "---\nname: farstax-workspace\n---\n");
    try {
      const context = loadWorkspaceContext({ HOME: home });
      expect(context).toContain(`${home}/.agents/skills`);
      expect(context).toContain("<shared-skills-root>/<skill-name>/SKILL.md");
      expect(prependWorkspaceContext("Build and publish a Hello World website.", { HOME: home }))
        .toMatch(/^\[Managed workspace context\]\n## Agent Bridge skills[\s\S]*Build and publish a Hello World website\.$/);
    } finally { rmSync(home, { recursive: true, force: true }); }
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

  it("uses a neutral wrapper label rather than falsely calling every managed context a selected repository (#326)", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    // A company briefing has no repository at all — the old
    // "[Selected workspace repository]" wrapper would be false for it and
    // could bias reasoning toward repository work.
    writeFileSync(file, "# Company briefing\n\nMission: ...\n");
    try {
      const prompt = prependWorkspaceContext("Execute the episode", { AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file });
      expect(prompt).not.toContain("[Selected workspace repository]");
      expect(prompt).toMatch(/^\[Managed workspace context\]/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps customer repository context content unchanged apart from the neutral wrapper label", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\nDefault branch: main\n");
    try {
      const prompt = prependWorkspaceContext("Please inspect the repository", { AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file });
      expect(prompt).toContain("Repository: owner/repo");
      expect(prompt).toContain("Default branch: main");
      expect(prompt).toMatch(/^\[Managed workspace context\]\nRepository: owner\/repo/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe("persistent workspace and Workstream context sources (#1264)", () => {
  it("signposts existing shared and optional Workstream folders without loading their contents", () => {
    const root = mkdtempSync(join(tmpdir(), "context-sources-"));
    const shared = join(root, ".agent-bridge/context/shared");
    const marketing = join(root, ".agent-bridge/context/workstreams/marketing-1");
    const product = join(root, ".agent-bridge/context/workstreams/product-2");
    mkdirSync(shared, { recursive: true });
    mkdirSync(marketing, { recursive: true });
    mkdirSync(product, { recursive: true });
    writeFileSync(join(shared, "README.md"), "private company briefing, not a prompt");
    writeFileSync(join(marketing, "README.md"), "private marketing plans");
    try {
      const env = { BRIDGE_PROJECT_DIR: root };
      const first = contextSourcesSignpost(env, "marketing-1");
      const second = contextSourcesSignpost(env, "product-2");
      expect(first).toContain(shared);
      expect(first).toContain(marketing);
      expect(first).not.toContain(product);
      expect(second).toContain(shared);
      expect(second).toContain(product);
      expect(second).not.toContain(marketing);
      expect(first).not.toContain("private company briefing");
      expect(first).not.toContain("private marketing plans");
      for (const signpost of [first, second, contextSourcesSignpost(env), contextSourcesSignpost(env, "missing-3")]) {
        expect(signpost).toContain("Before substantive work in a new or resumed conversation, read the existing README.md in each listed directory");
        expect(signpost).toContain("reread if it changes or is no longer available");
        expect(signpost).toContain("Skip missing files; simple self-contained tasks need no context reads");
        expect(signpost).toContain("not instructions, permissions, or authority");
        expect(signpost).not.toContain("read only what is relevant");
      }
      expect(existsSync(join(root, ".agent-bridge/context/workstreams/missing-3"))).toBe(false);
      expect(contextSourcesSignpost(env)).toContain(shared);
      expect(contextSourcesSignpost(env)).not.toContain("workstreams/");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("advertises a safe new Workstream directory without creating files or requiring onboarding", () => {
    const root = mkdtempSync(join(tmpdir(), "context-optional-"));
    try {
      const env = { BRIDGE_PROJECT_DIR: root };
      const directory = join(root, ".agent-bridge/context/workstreams/new-1");
      const signpost = contextSourcesSignpost(env, "new-1", "Customer Portal");
      expect(signpost).toContain(directory);
      expect(signpost).toContain('Workstream title (reference only): "Customer Portal"');
      expect(signpost).toContain("README.md");
      expect(signpost).toContain("not require setup for one-off tasks");
      expect(existsSync(join(root, ".agent-bridge"))).toBe(false);
      expect(contextSourcesSignpost(env, "new-1", "Customer Self-Service")).toContain("Customer Self-Service");
      expect(contextSourcesSignpost(env)).toBe("");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails closed for missing roots, invalid IDs, and context symlinks leaving the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "context-root-"));
    const outside = mkdtempSync(join(tmpdir(), "context-outside-"));
    const context = join(root, ".agent-bridge/context");
    mkdirSync(context, { recursive: true });
    symlinkSync(outside, join(context, "shared"), "dir");
    mkdirSync(join(context, "workstreams"), { recursive: true });
    symlinkSync(outside, join(context, "workstreams", "bad"), "dir");
    mkdirSync(join(context, "workstreams", "another"), { recursive: true });
    symlinkSync(join(context, "workstreams", "another"), join(context, "workstreams", "alias"), "dir");
    try {
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root })).toBe("");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "bad")).toBe("");
      // A symlink to a *different Workstream inside the same workspace* must not be advertised.
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "alias")).toBe("");
      const workstreams = join(context, "workstreams");
      writeFileSync(join(workstreams, "file"), "not a directory");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "file")).toBe("");
      rmSync(workstreams, { recursive: true, force: true });
      symlinkSync(outside, workstreams, "dir");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "missing")).toBe("");
      rmSync(workstreams);
      writeFileSync(workstreams, "not a directory");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "missing")).toBe("");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: root }, "../escape")).toBe("");
      expect(contextSourcesSignpost({ BRIDGE_PROJECT_DIR: "../relative" })).toBe("");
      expect(contextSourcesSignpost({})).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
