import { describe, expect, it } from "vitest";
import { prependWorkspaceContext } from "../src/workspaceContext.js";

describe("runtime inspector agent orientation", () => {
  it("injects only a compact read-only inspector pointer for a live runtime", () => {
    const prompt = prependWorkspaceContext("Please inspect the repository", {
      NODE_ENV: "production",
      DB_PATH: "/runtime/bridge.sqlite",
    });

    expect(prompt).toContain("[Agent Bridge runtime]");
    expect(prompt).toContain("bin/agent-bridge-inspect");
    expect(prompt).toContain("capabilities --json");
    expect(prompt).toContain("does not grant mutation authority");
    expect(prompt).toContain("Please inspect the repository");
    expect(prompt.length).toBeLessThan(1_000);
    expect(prompt).not.toContain('"activeRuns"');
  });
});
