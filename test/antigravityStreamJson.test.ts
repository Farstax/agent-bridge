import { describe, expect, it } from "vitest";
import { buildCliInvocation, parseCliResult } from "../src/cli.js";

describe("Agy ACP invocation and parsing contract", () => {
  it("selects ACP stdio instead of native --print stream-json", () => {
    const invocation = buildCliInvocation({
      bot: "antigravity",
      prompt: "hello",
      sessionId: null,
      command: "agy_acp_server.par",
      model: null,
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["--uid="]);
    expect(invocation.args).not.toContain("--print");
    expect(invocation.args).not.toContain("--output-format");
  });

  it("does not parse native stream-json as an Agy ACP result", () => {
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        event: "result",
        result: {
          conversation_id: "11111111-2222-3333-4444-555555555555",
          status: "SUCCESS",
          response: "stream response",
        },
      }) + "\n",
    })).toThrow(/ACP structured results/);
  });
});
