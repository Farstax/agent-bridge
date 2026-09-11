import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

function agyPrintPrompt(args: string[]): string {
  const index = args.indexOf("--print");
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

describe("provider-native terminal completion", () => {
  it("does not alter the Claude ACP invocation for the shared nativeCompletion hint", () => {
    const ordinary = buildCliInvocation({
      bot: "claude",
      prompt: "run the tests",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: true,
    });
    const native = buildCliInvocation({
      bot: "claude",
      prompt: "run the tests",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: false,
    });

    expect(ordinary).toEqual(native);
  });

  it("does not rewrite ordinary Agy prompts into /goal", () => {
    const ordinary = buildCliInvocation({
      bot: "antigravity",
      prompt: "run the tests",
      sessionId: null,
      command: "agy",
      model: null,
      nativeCompletion: true,
    });
    const native = buildCliInvocation({
      bot: "antigravity",
      prompt: "run the tests",
      sessionId: null,
      command: "agy",
      model: null,
      nativeCompletion: false,
    });

    expect(agyPrintPrompt(ordinary.args)).not.toMatch(/^\/goal\s/);
    expect(ordinary).toEqual(native);
  });

  it("does not alter the Codex ACP invocation for the shared nativeCompletion hint", () => {
    const ordinary = buildCliInvocation({
      bot: "codex",
      prompt: "run the tests",
      sessionId: null,
      command: "codex",
      model: null,
      nativeCompletion: true,
    });
    const bounded = buildCliInvocation({
      bot: "codex",
      prompt: "run the tests",
      sessionId: null,
      command: "codex",
      model: null,
      nativeCompletion: false,
    });

    expect(ordinary).toEqual(bounded);
  });
});

