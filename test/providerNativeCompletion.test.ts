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
  it("enables a Claude Stop gate only for provider-owned terminal completion", () => {
    const ordinary = buildCliInvocation({
      bot: "claude",
      prompt: "run the tests",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: true,
    });
    const bounded = buildCliInvocation({
      bot: "claude",
      prompt: "one bounded probe",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: false,
    });

    const settings = claudeSettings(ordinary.args) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ type?: string; prompt?: string; timeout?: number }> }> };
    };
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]).toMatchObject({
      type: "prompt",
      timeout: 30,
    });
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.prompt).toMatch(/background|monitor|asynchronous/i);
    expect(claudeSettings(bounded.args)).not.toHaveProperty("hooks.Stop");
  });

  it("does not treat conditional authorization offers as committed outstanding work", () => {
    const invocation = buildCliInvocation({
      bot: "claude",
      prompt: "offer to run the deployment after I approve it",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: true,
    });

    const prompt = (claudeSettings(invocation.args).hooks as {
      Stop: Array<{ hooks: Array<{ prompt?: string }> }>;
    }).Stop[0].hooks[0].prompt;
    expect(prompt).toMatch(/conditional|authorization|permission/i);
    expect(prompt).toMatch(/accepted|committed|authorized/i);
  });

  it("does not claim unrelated processes observed during diagnostics", () => {
    const invocation = buildCliInvocation({
      bot: "claude",
      prompt: "inspect the current processes and report",
      sessionId: null,
      command: "claude",
      model: null,
      nativeCompletion: true,
    });

    const prompt = (claudeSettings(invocation.args).hooks as {
      Stop: Array<{ hooks: Array<{ prompt?: string }> }>;
    }).Stop[0].hooks[0].prompt;
    expect(prompt).toMatch(/observed|diagnostic|process listing/i);
    expect(prompt).toMatch(/initiated|current turn|this turn/i);
  });

  it("uses Agy's native goal lifecycle only for provider-owned terminal completion", () => {
    const ordinary = buildCliInvocation({
      bot: "antigravity",
      prompt: "run the tests",
      sessionId: null,
      command: "agy",
      model: null,
      nativeCompletion: true,
    });
    const bounded = buildCliInvocation({
      bot: "antigravity",
      prompt: "one bounded probe",
      sessionId: null,
      command: "agy",
      model: null,
      nativeCompletion: false,
    });

    expect(agyPrintPrompt(ordinary.args)).toMatch(/^\/goal\s/);
    expect(agyPrintPrompt(bounded.args)).not.toMatch(/^\/goal\s/);
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
