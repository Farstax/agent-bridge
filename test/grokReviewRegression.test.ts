import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";

function grokStream(events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

describe("Grok review regressions", () => {
  it("maps effort through the provider-owned native headless flag for custom executables", () => {
    const invocation = buildCliInvocation({
      bot: "grok",
      prompt: "think carefully",
      sessionId: null,
      command: "/opt/xai/bin/custom-grok",
      effort: "high",
      includeResponseContract: false,
    });

    expect(invocation.command).toBe("/opt/xai/bin/custom-grok");
    expect(invocation.args).toContain("--effort");
    expect(invocation.args[invocation.args.indexOf("--effort") + 1]).toBe("high");
  });

  it("rejects answer data after the terminal end event", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "authoritative" },
        { type: "end", stopReason: "end_turn", sessionId: "sess-1" },
        { type: "text", data: "late" },
      ]),
    })).toThrow(/after terminal end/i);
  });

  it("rejects duplicate terminal events instead of allowing a later success to overwrite failure", () => {
    expect(() => parseCliResult({
      bot: "grok",
      stdout: grokStream([
        { type: "text", data: "partial" },
        { type: "end", stopReason: "cancelled", sessionId: "sess-2" },
        { type: "end", stopReason: "end_turn", sessionId: "sess-2" },
      ]),
    })).toThrow(/after terminal end/i);
  });
});
