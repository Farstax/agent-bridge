import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("parseCliResult edge cases", () => {
  it("requires a Codex final text event instead of using deltas", () => {
    const deltas = [
      JSON.stringify({ type: "response.output_text.delta", delta: "Hello " }),
      JSON.stringify({ type: "response.output_text.delta", delta: "world" }),
    ].join("\n");
    expect(() => parseCliResult({ bot: "codex", stdout: deltas }))
      .toThrow(/completion could not be verified/i);

    const withFinal = [
      deltas,
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } }),
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout: withFinal }).text).toBe("Final answer");
  });

  it("fails closed for empty Codex stdout", () => {
    expect(() => parseCliResult({ bot: "codex", stdout: "" }))
      .toThrow(/completion could not be verified/i);
  });

  it("uses the final Claude result line and trims its text", () => {
    const stdout = [
      JSON.stringify({ type: "result", result: "first", session_id: "session-0" }),
      JSON.stringify({ type: "assistant", content: "interim" }),
      JSON.stringify({ type: "result", result: "  Final answer  ", session_id: "session-1" }),
    ].join("\n");

    expect(parseCliResult({ bot: "claude", stdout })).toMatchObject({
      text: "Final answer",
      sessionId: "session-1",
    });
  });
});
