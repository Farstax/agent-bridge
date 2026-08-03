import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("initial installation release contract", () => {
  it("packages the initial installer, guarded deployer and service units", () => {
    const workflow = readFileSync(".github/workflows/release-artifact.yml", "utf8");

    for (const requiredPath of [
      "scripts/agent-bridge-install.py",
      "scripts/agent-bridge-deploy.py",
      "scripts/rollout-agent-bridge.sh",
      "scripts/release-activate.py",
      "scripts/rollout-authorization.py",
      "scripts/rollout-acceptance.py",
      "systemd/agent-bridge-*.service",
      "systemd/agent-bridge-tmp-cleanup.timer",
    ]) {
      expect(workflow).toContain(requiredPath);
    }
  });
});
