import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prependWorkspaceContext, runtimeInspectorContext } from "../src/workspaceContext.js";

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

  it("uses BRIDGE_PROJECT_DIR rather than the process working directory for the inspector pointer", () => {
    const root = join(tmpdir(), `agent-bridge-inspector-context-${process.pid}-${Date.now()}`);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "agent-bridge-inspect"), "#!/usr/bin/env bash\n");
    try {
      const context = runtimeInspectorContext({
        NODE_ENV: "production",
        BRIDGE_PROJECT_DIR: root,
      }, "/wrong/repository/root");
      expect(context).toContain(join(root, "bin", "agent-bridge-inspect"));
      expect(context).not.toContain("/wrong/repository/root");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
