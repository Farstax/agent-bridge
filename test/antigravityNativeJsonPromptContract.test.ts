import { afterEach, describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const originalOutputMode = process.env.ANTIGRAVITY_OUTPUT_MODE;

afterEach(() => {
  if (originalOutputMode === undefined) delete process.env.ANTIGRAVITY_OUTPUT_MODE;
  else process.env.ANTIGRAVITY_OUTPUT_MODE = originalOutputMode;
});

describe("Agy native JSON response prompt contract", () => {
  it("keeps the native response field focused on the final user-facing answer", () => {
    process.env.ANTIGRAVITY_OUTPUT_MODE = "json";

    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "review the service",
      sessionId: null,
      command: "agy",
      model: null,
    });

    const prompt = invocation.args.at(-1) ?? "";
    expect(prompt).toContain("The native JSON envelope's response field is the final user-facing answer.");
    expect(prompt).toContain(
      "Do not include background-task lifecycle notifications, raw tool stdout/stderr, or internal execution telemetry unless the user explicitly requests that information or it is materially necessary to explain the result.",
    );
    expect(prompt).not.toContain('schema: {"response"');
  });
});
