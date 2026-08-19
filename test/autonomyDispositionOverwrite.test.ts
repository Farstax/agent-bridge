import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createAutonomyDispositionChannel } from "../src/autonomyDisposition.js";

describe("autonomy disposition overwrite", () => {
  it("lets the final valid disposition win when the provider calls the helper multiple times", () => {
    const channel = createAutonomyDispositionChannel(`overwrite-${Date.now()}-${Math.random()}`);
    try {
      execFileSync(channel.commandPath, ["continue"]);
      execFileSync(channel.commandPath, ["done", "--notify"]);

      expect(channel.read()).toEqual({ disposition: "done", notify: true });
    } finally {
      channel.cleanup();
    }
  });

  it("does not let an invalid later call destroy the last valid disposition", () => {
    const channel = createAutonomyDispositionChannel(`overwrite-invalid-${Date.now()}-${Math.random()}`);
    try {
      execFileSync(channel.commandPath, ["done"]);
      expect(() => execFileSync(channel.commandPath, ["bogus"])).toThrow();

      expect(channel.read()).toEqual({ disposition: "done", notify: false });
    } finally {
      channel.cleanup();
    }
  });
});
