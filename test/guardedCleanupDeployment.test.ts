import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release-artifact.yml", import.meta.url), "utf8");
const historicalWorkflow = readFileSync(new URL("../.github/workflows/historical-release-artifact.yml", import.meta.url), "utf8");
const rollout = readFileSync(new URL("../scripts/rollout-agent-bridge.sh", import.meta.url), "utf8");
const cleanupService = readFileSync(new URL("../systemd/agent-bridge-tmp-cleanup.service", import.meta.url), "utf8");

describe("guarded cleanup deployment contract", () => {
  it("packages the cleanup executable and both units into the immutable release", () => {
    expect(workflow).toContain("scripts/reap-tmp-artifacts.sh");
    expect(workflow).toContain("systemd/agent-bridge-tmp-cleanup.service");
    expect(workflow).toContain("systemd/agent-bridge-tmp-cleanup.timer");
    expect(historicalWorkflow).toContain("scripts/reap-tmp-artifacts.sh");
    expect(historicalWorkflow).toContain("systemd/agent-bridge-tmp-cleanup.service");
    expect(historicalWorkflow).toContain("systemd/agent-bridge-tmp-cleanup.timer");
  });

  it("keeps cleanup timer lifecycle separate from the seven application services", () => {
    expect(rollout).toContain("agent-bridge-tmp-cleanup.service");
    expect(rollout).toContain("agent-bridge-tmp-cleanup.timer");
    expect(rollout).toContain("daemon-reload");
    expect(rollout).toContain("is-enabled");
    expect(rollout).toContain("ActiveState");
    expect(rollout).toContain("TimersCalendar");
    expect(rollout).toContain("cleanup timer");
  });

  it("binds the installed cleanup unit to the expected release manifest", () => {
    expect(rollout).toContain("scripts/reap-tmp-artifacts.sh");
    expect(rollout).toContain("manifest.json");
    expect(rollout).toContain("sha256sum");
    expect(rollout).toContain("rollback cleanup timer");
  });

  it("runs only the bounded immutable cleanup command with elevated service authority", () => {
    expect(cleanupService).toContain("User=BRIDGE_USER");
    expect(cleanupService).toContain("ExecStart=+/usr/bin/env bash");
    expect(cleanupService).toContain("scripts/reap-tmp-artifacts.sh");
    expect(cleanupService).not.toContain("ExecStart=/usr/bin/env bash");
  });
});
