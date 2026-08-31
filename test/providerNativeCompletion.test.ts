import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";

function claudeSettings(args: string[]): Record<string, unknown> {
  const index = args.indexOf("--settings");
  expect(index).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[index + 1]);
}

function agyPrintPrompt(args: string[]): string {
  const index = args.indexOf("--print");
  expect(index).toBeGreaterThanOrEqual(0);
  return args[index + 1];
}

describe("provider-native terminal completion", () => {
  it("does not override Claude's native Stop lifecycle", () => {
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

    expect(claudeSettings(ordinary.args)).not.toHaveProperty("hooks.Stop");
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

  it("does not invent a native completion wrapper for Codex", () => {
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

  it("treats Claude background Bash records as provider-owned output, not a Bridge continuation request", () => {
    const result = parseCliResult({
      bot: "claude",
      stdout: [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test","run_in_background":true}}]}}',
        '{"type":"result","subtype":"success","result":"Tests are running.","session_id":"sess-9"}',
      ].join("\n"),
    });

    expect(result).toEqual({
      text: "Tests are running.",
      sessionId: "sess-9",
    });
  });
});
