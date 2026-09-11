import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("parseCliResult edge cases", () => {
  it("uses the final Cursor result line and trims its text", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", content: "interim" }),
      JSON.stringify({ type: "result", result: "  Final answer  ", session_id: "session-1" }),
    ].join("\n");

    expect(parseCliResult({ bot: "cursor", stdout })).toMatchObject({
      text: "Final answer",
      sessionId: "session-1",
    });
  });

  it("fails closed when parseCliResult is called on ACP-backed claude", () => {
    expect(() => parseCliResult({ bot: "claude", stdout: "{}" })).toThrow(/ACP structured results/);
  });
});
