import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkspaceContext } from "../src/workspaceContext.js";

describe("workspace context", () => {
  it("loads the platform-owned repository context without exposing unrelated environment values", () => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: owner/repo\n");
    try {
      expect(loadWorkspaceContext({ AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file, GITHUB_TOKEN: "secret" })).toContain("owner/repo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
