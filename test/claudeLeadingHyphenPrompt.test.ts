import { describe, expect, it } from "vitest";
import { buildCliInvocation } from "../src/cli.js";

describe("Claude leading-hyphen prompt argv handling", () => {
  it("terminates option parsing before a fresh raw prompt that starts with a hyphen", () => {
    const prompt = "- existing attempt is rediscovered;";
    const inv = buildCliInvocation({
      bot: "claude",
      prompt,
      sessionId: null,
      command: "claude",
      includeResponseContract: false,
    });

    expect(inv.args.slice(-2)).toEqual(["--", prompt]);
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

  it("preserves the existing argv shape for raw prompts that do not start with a hyphen", () => {
    const prompt = "existing attempt is rediscovered;";
    const inv = buildCliInvocation({
      bot: "claude",
      prompt,
      sessionId: null,
      command: "claude",
      includeResponseContract: false,
    });

    expect(inv.args.at(-1)).toBe(prompt);
    expect(inv.args.at(-2)).not.toBe("--");
  });
});
