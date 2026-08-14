import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapPromptContext } from "../src/promptWrapping.js";
import { prependWorkspaceContext } from "../src/workspaceContext.js";

const EXECUTION_CONTRACT_MARKER = "Agent Bridge execution contract:";

const SOUL_WITH_STYLE = [
  "## Identity",
  "Operator",
  "",
  "## Communication Style",
  "- Be concise.",
].join("\n");

describe("fresh-session execution contract", () => {
  it("seeds universal execution rules even when SOUL owns communication style", () => {
    const wrapped = wrapPromptContext("ship the requested change", SOUL_WITH_STYLE, true);

    expect(wrapped).toContain(EXECUTION_CONTRACT_MARKER);
    expect(wrapped).toContain("A question asks for an answer");
    expect(wrapped).toContain("complete the requested scope");
    expect(wrapped).toContain("reversible, low-cost actions");
    expect(wrapped).toContain("external audience");
    expect(wrapped).toContain("directly block or are caused by the requested work");
    expect(wrapped).toContain("complete the unblocked work");
    expect(wrapped).toContain("Do not claim work was completed or verified unless it was");

    // SOUL still owns response style; the old minimal response contract stays suppressed.
    expect(wrapped).toContain("Soul contract:");
    expect(wrapped).toContain("## Communication Style");
    expect(wrapped).not.toContain("Response contract:");
  });

  it("omits the execution contract when Bridge context is disabled for native resume", () => {
    const wrapped = wrapPromptContext("continue the native session", null, false);

    expect(wrapped).toBe("continue the native session");
    expect(wrapped).not.toContain(EXECUTION_CONTRACT_MARKER);
    expect(wrapped).not.toContain("Response contract:");
  });

  it("preserves the existing minimal response contract for a fresh session without configured style", () => {
    const wrapped = wrapPromptContext("answer this", null, true);

    expect(wrapped).toContain(EXECUTION_CONTRACT_MARKER);
    expect(wrapped).toContain("Response contract:");
    expect(wrapped).toContain("User request:\nanswer this");
  });

  it("keeps the Farstax workspace overlay independent on resumed turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-overlay-"));
    const file = join(dir, "workspace-context.md");
    writeFileSync(file, "Repository: farstax/example\nDefault branch: main\n");

    try {
      const workspacePrompt = prependWorkspaceContext("continue", {
        AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file,
        HOME: dir,
      });
      const resumedPrompt = wrapPromptContext(workspacePrompt, null, false);

      expect(resumedPrompt).toContain("[Selected workspace repository]");
      expect(resumedPrompt).toContain("Repository: farstax/example");
      expect(resumedPrompt).toContain("## Agent Bridge skills");
      expect(resumedPrompt).not.toContain(EXECUTION_CONTRACT_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
