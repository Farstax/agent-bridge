import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

describe("clean-droplet acceptance", () => {
  it("starts the first Codex invocation with codex exec, never codex exec resume", () => {
    const invocation = buildCliInvocation({
      bot: "codex",
      command: "codex",
      model: null,
      prompt: "first request on a new appliance",
      sessionId: null,
      executionMode: "trusted",
      outputFormat: "json",
      soulContext: null,
      includeResponseContract: true,
      attachments: [],
      outputDir: null,
      effort: null,
      toolMode: "default",
    });
    expect(invocation.args[0]).toBe("exec");
    expect(invocation.args[1]).not.toBe("resume");
    expect(invocation.args).not.toContain("resume");
  });
});
