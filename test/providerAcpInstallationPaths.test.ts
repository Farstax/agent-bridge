import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

describe("ACP provider installation paths", () => {
  it("installs bundled SDK adapters through the release dependency set", () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toMatchObject({
      "@agentclientprotocol/sdk": expect.any(String),
      "@agentclientprotocol/codex-acp": expect.any(String),
      "@agentclientprotocol/claude-agent-acp": expect.any(String),
      "@xai-official/grok": expect.any(String),
    });
  });

  it("keeps Agy and Cursor in guarded release activation", () => {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
      agentBridge?: { hostComponents?: Array<{ id: string; installer: string }> };
    };
    const install = readFileSync(resolve(repoRoot, "scripts/install.sh"), "utf8");
    const upgrade = readFileSync(resolve(repoRoot, "scripts/upgrade.sh"), "utf8");
    const activation = readFileSync(resolve(repoRoot, "scripts/release-activate.py"), "utf8");
    const rollout = readFileSync(resolve(repoRoot, "scripts/rollout-agent-bridge.sh"), "utf8");

    expect(manifest.agentBridge?.hostComponents).toContainEqual({
      id: "agy-acp",
      installer: "scripts/install-agy-acp.sh",
      phase_protocol: 1,
    });
    expect(manifest.agentBridge?.hostComponents).toContainEqual({
      id: "cursor-acp",
      installer: "scripts/install-cursor-acp.sh",
      phase_protocol: 1,
    });
    const cursorInstaller = readFileSync(resolve(repoRoot, "scripts/install-cursor-acp.sh"), "utf8");
    expect(cursorInstaller).toContain("AGENT_BRIDGE_CURSOR_ACP_USER");
    expect(cursorInstaller).toContain("sha256sum");
    expect(cursorInstaller).toContain("binary?.sha256");
    expect(cursorInstaller).toContain('id -un');
    expect(cursorInstaller).not.toContain('$(id -u)" == "0"');
    expect(activation).toContain('"/usr/sbin/runuser"');
    expect(install).toContain("install-cursor-acp.sh");
    expect(upgrade).toContain("install-cursor-acp.sh");
    expect(activation).toContain('component["id"] == "cursor-acp"');
    expect(activation).toContain("AGENT_BRIDGE_CURSOR_ACP_USER");
    expect(rollout).toContain("export AGENT_BRIDGE_RUNTIME_USER");
  });
});
