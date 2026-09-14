import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("Agy stream-json compatibility invariants", () => {
  it("does not parse native stream-json after ACP migration", () => {
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        event: "result",
        result: {
          conversation_id: "11111111-2222-3333-4444-555555555555",
          status: "ERROR",
          response: "",
          error: "No capacity available for selected model",
        },
      }) + "\n",
    })).toThrow(/ACP structured results/);
  });
});
