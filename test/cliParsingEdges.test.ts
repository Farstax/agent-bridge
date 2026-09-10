import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("parseCliResult edge cases", () => {
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
