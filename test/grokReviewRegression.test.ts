import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";
import { grokAcpPolicy } from "../src/providers/grokAcpPolicy.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

function request(overrides: Partial<ProviderInvocationRequest> = {}): ProviderInvocationRequest {
  return {
    prompt: "think carefully",
    sessionId: null,
    command: "grok",
    model: null,
    executionMode: "safe",
    outputFormat: "json",
    soulContext: null,
    attachments: [],
    outputDir: null,
    effort: "high",
    toolMode: "default",
    ...overrides,
  };
}

describe("Grok review regressions", () => {
  it("maps effort through ACP session configuration rather than a native flag", () => {
    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "think carefully",
      sessionId: null,
      command: "/opt/xai/bin/custom-grok",
      effort: "high",
      includeResponseContract: false,
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["agent", "stdio"]);
    expect(invocation.args).not.toContain("--effort");
    expect(grokAcpPolicy.sessionSettings?.(request(), {})?.config).toEqual([
      { category: "thought_level", explicitValue: "high", preferredValues: [] },
    ]);
  });

  it("does not parse native streaming-json as a Grok ACP result", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: [
        JSON.stringify({ type: "text", data: "authoritative" }),
        JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "sess-1" }),
      ].join("\n") + "\n",
    })).toThrow(/ACP structured results/);
  });
});
