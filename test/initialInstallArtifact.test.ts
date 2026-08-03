import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("initial installation release contract", () => {
  it("packages the initial installer, guarded deployer and service units", () => {
    const workflow = readFileSync(".github/workflows/release-artifact.yml", "utf8");

    for (const requiredPath of [
      "scripts/agent-bridge-install.py",
      "scripts/rollout-db.ts",
      "scripts/rollout-db-impl.ts",
      "scripts/agent-bridge-deploy.py",
      "scripts/rollout-agent-bridge.sh",
      "scripts/release-activate.py",
      "scripts/rollout-authorization.py",
      "scripts/rollout-acceptance.py",
      "systemd/agent-bridge-antigravity.service",
      "systemd/agent-bridge-claude.service",
      "systemd/agent-bridge-codex.service",
      "systemd/agent-bridge-discord-interactive.service",
      "systemd/agent-bridge-health.service",
      "systemd/agent-bridge-interactive.service",
      "systemd/agent-bridge-worker-bot.service",
      "systemd/agent-bridge-tmp-cleanup.service",
      "systemd/agent-bridge-tmp-cleanup.timer",
    ]) {
      expect(workflow).toContain(requiredPath);
    }
  });
});
