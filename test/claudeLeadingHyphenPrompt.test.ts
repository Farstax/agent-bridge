import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

const EXECUTION_CONTRACT_MARKER = "Agent Bridge execution contract:";

describe("Claude leading-hyphen prompt argv handling", () => {
  it("wraps a fresh raw leading-hyphen prompt in the execution contract before argv parsing", () => {
    const prompt = "- existing attempt is rediscovered;";
    const inv = buildCliInvocation({
      bot: "claude",
      prompt,
      sessionId: null,
      command: "claude",
      includeResponseContract: false,
    });

    expect(inv.args.at(-1)).toContain(EXECUTION_CONTRACT_MARKER);
    expect(inv.args.at(-1)).toContain(prompt);
    expect(inv.args.at(-2)).not.toBe("--");
    expect(inv.stdin).toBeUndefined();
  });

  it("terminates option parsing before a resumed raw prompt that starts with a hyphen", () => {
    const prompt = "- existing attempt is rediscovered;";
    const inv = buildCliInvocation({
      bot: "claude",
      prompt,
      sessionId: "sess-1",
      command: "claude",
      includeResponseContract: false,
    });

    expect(inv.args).toContain("--resume");
    expect(inv.args).toContain("sess-1");
    expect(inv.args.slice(-2)).toEqual(["--", prompt]);
  });

  it("wraps a fresh raw non-hyphen prompt in the execution contract", () => {
    const prompt = "existing attempt is rediscovered;";
    const inv = buildCliInvocation({
      bot: "claude",
      prompt,
      sessionId: null,
      command: "claude",
      includeResponseContract: false,
    });

    expect(inv.args.at(-1)).toContain(EXECUTION_CONTRACT_MARKER);
    expect(inv.args.at(-1)).toContain(prompt);
    expect(inv.args.at(-2)).not.toBe("--");
  });
});
