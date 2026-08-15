import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const base = {
  command: "provider",
  model: null,
  executionMode: "safe" as const,
  outputFormat: null,
  soulContext: null,
  includeResponseContract: false,
  outputDir: null,
  attachments: [],
};

describe("Issue #387 native invocation boundary", () => {
  it("reports resume when Claude resumes a stored native session", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "claude",
      prompt: "continue",
      sessionId: "claude-session",
    });

    expect(invocation.nativeSessionMode).toBe("resume");
    expect(invocation.args).toContain("--resume");
  });

  it("reports fresh when Codex uses attachments despite a stored session", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "codex",
      prompt: "inspect this image",
      sessionId: "codex-session",
      attachments: ["/tmp/image.png"],
    });

    expect(invocation.nativeSessionMode).toBe("fresh");
    expect(invocation.args).not.toContain("resume");
    expect(invocation.args).toContain("-i");
  });

  it("reports fresh when a provider has no resumable session", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "antigravity",
      prompt: "start",
      sessionId: null,
    });

    expect(invocation.nativeSessionMode).toBe("fresh");
  });
});
