import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade CLI verification", () => {
  it("fails when the release-owned Claude ACP runtime cannot be verified", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    const claudeAcp = join(root, "claude-agent-acp");
    writeFileSync(claudeAcp, "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unable to verify release-owned Claude ACP runtime version");
  });

  it("requires a valid version from the Claude ACP runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    const claudeAcp = join(root, "claude-agent-acp");
    writeFileSync(claudeAcp, "#!/usr/bin/env bash\nif [ \"$1\" = --version ]; then echo 'no version here'; exit 0; fi\nexit 0\n", { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unable to verify release-owned Claude ACP runtime version");
  });

  it("runs bounded provider qualification for the verified Claude version", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-"));
    const node = join(root, "node");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    const claudeAcp = join(root, "claude-agent-acp");
    writeFileSync(claudeAcp, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo '@agentclientprotocol/claude-agent-acp 0.76.0'; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    const invocations = readFileSync(log, "utf8");
    expect(invocations).toContain("provider-qualification.ts --provider claude --expected-version 0.76.0");
    expect(invocations).toContain("--previous-version 0.76.0");
    expect(result.stdout).toContain("[qualification] claude 0.76.0");
  });

  it("verifies and qualifies the active Claude ACP runtime in update mode", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-claude-runtime-"));
    const node = join(root, "node");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    const claudeAcp = join(root, "claude-agent-acp");
    writeFileSync(claudeAcp, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo '@agentclientprotocol/claude-agent-acp 0.76.0'; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--update"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("provider-qualification.ts --provider claude --expected-version 0.76.0");
  });

  it("fails when the active Claude ACP runtime version cannot be verified after update", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-claude-drift-"));
    const node = join(root, "node");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    const claudeAcp = join(root, "claude-agent-acp");
    writeFileSync(claudeAcp, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo "not-a-version"; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--update"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unable to verify active Claude runtime version after update");
    expect(existsSync(log)).toBe(false);
  });

  it("keeps the upgraded CLI installed when qualification fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-fail-"));
    const node = join(root, "node");
    const claudeAcp = join(root, "claude-agent-acp");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
provider=claude
if [[ " $* " == *" --provider codex "* ]]; then provider=codex; fi
printf '{"ran":true,"provider":"%s","providerVersion":"0.76.0","overall":"fail","checks":[]}\\n' "$provider"
exit 1
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(claudeAcp, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo '@agentclientprotocol/claude-agent-acp 0.76.0'; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("provider marked degraded; no automatic rollback");
  });

  it("fails the upgrade when the qualification runner itself fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-runner-fail-"));
    const node = join(root, "node");
    const claudeAcp = join(root, "claude-agent-acp");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
exit 1
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(claudeAcp, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo '@agentclientprotocol/claude-agent-acp 0.76.0'; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claudeAcp, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_ACP_COMMAND: claudeAcp, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("qualification runner failed");
  });
});
