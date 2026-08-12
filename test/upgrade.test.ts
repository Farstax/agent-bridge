import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("upgrade CLI verification", () => {
  it("fails when npm installation fails instead of suppressing the error", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [ "$1" = list ]; then echo '@scope/pkg@1.0.0'; exit 0; fi\nexit 42\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm CLI installation failed");
  });

  it("requires a version after installation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    writeFileSync(node, "#!/usr/bin/env bash\nif [ \"$1\" = \"-p\" ]; then echo 24.0.0; else exit 0; fi\n", { mode: 0o755 });
    chmodSync(node, 0o755);
    const claude = join(root, "claude");
    writeFileSync(claude, "#!/usr/bin/env bash\nif [ \"$1\" = update ]; then exit 0; fi\nexit 0\n", { mode: 0o755 });
    chmodSync(claude, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash\nif [ "$1" = list ]; then exit 1; fi\nexit 0\n`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });
    expect(result.status).not.toBe(0);
  });

  it("runs bounded provider qualification for verified Claude and Codex versions", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    const state = join(root, "installed");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = list ]; then
  version=1.0.0
  [ ! -f "${state}" ] || version=1.1.0
  pkg=""
  for arg in "$@"; do
    case "$arg" in
      @anthropic-ai/claude-code|@openai/codex) pkg="$arg" ;;
    esac
  done
  case "$pkg" in
    @anthropic-ai/claude-code) echo "@anthropic-ai/claude-code@$version" ;;
    @openai/codex) echo "@openai/codex@$version" ;;
  esac
  exit 0
fi
if [ "$1" = install ]; then touch "${state}"; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    const claude = join(root, "claude");
    writeFileSync(claude, "#!/usr/bin/env bash\nif [ \"$1\" = --version ]; then echo 'Claude Code 1.1.0'; exit 0; fi\nif [ \"$1\" = update ]; then exit 0; fi\nexit 0\n", { mode: 0o755 });
    chmodSync(claude, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    const invocations = readFileSync(log, "utf8");
    expect(invocations).toContain("provider-qualification.ts --provider claude --expected-version 1.1.0");
    expect(invocations).toContain("--previous-version 1.0.0");
    expect(invocations).toContain("provider-qualification.ts --provider codex --expected-version 1.1.0");
    expect(result.stdout).toContain("[qualification] claude 1.1.0");
    expect(result.stdout).toContain("[qualification] codex 1.1.0");
  });

  it("updates Claude through the active executable and qualifies its observed version", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-claude-runtime-"));
    const npm = join(root, "npm");
    const claude = join(root, "claude");
    const node = join(root, "node");
    const state = join(root, "claude-updated");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash
if [ "$1" = list ]; then
  echo '@anthropic-ai/claude-code@2.1.229'
  echo '@openai/codex@1.1.0'
  exit 0
fi
if [ "$1" = install ]; then exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    writeFileSync(claude, `#!/usr/bin/env bash
if [ "$1" = --version ]; then
  if [ -f "${state}" ]; then echo 'Claude Code 2.1.229'; else echo 'Claude Code 2.1.228'; fi
  exit 0
fi
if [ "$1" = update ]; then touch "${state}"; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claude, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[update] Updating Claude through the active executable");
    expect(readFileSync(log, "utf8")).toContain("provider-qualification.ts --provider claude --expected-version 2.1.229");
  });

  it("fails when Claude update succeeds but the active executable remains behind package metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-claude-drift-"));
    const npm = join(root, "npm");
    const claude = join(root, "claude");
    const node = join(root, "node");
    const log = join(root, "qualification.log");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${log}"
exit 0
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash
if [ "$1" = list ]; then
  echo '@anthropic-ai/claude-code@2.1.229'
  echo '@openai/codex@2.1.229'
  exit 0
fi
if [ "$1" = install ]; then exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    writeFileSync(claude, `#!/usr/bin/env bash
if [ "$1" = --version ]; then echo 'Claude Code 2.1.228'; exit 0; fi
if [ "$1" = update ]; then exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(claude, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Claude runtime");
    expect(existsSync(log)).toBe(false);
  });

  it("keeps the upgraded CLI installed when qualification fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-fail-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    const state = join(root, "installed");
    const claude = join(root, "claude");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
provider=claude
if [[ " $* " == *" --provider codex "* ]]; then provider=codex; fi
printf '{"ran":true,"provider":"%s","providerVersion":"1.1.0","overall":"fail","checks":[]}\\n' "$provider"
exit 1
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = list ]; then
  version=1.0.0
  [ ! -f "${state}" ] || version=1.1.0
  pkg=""
  for arg in "$@"; do
    case "$arg" in
      @anthropic-ai/claude-code|@openai/codex) pkg="$arg" ;;
    esac
  done
  case "$pkg" in
    @anthropic-ai/claude-code) echo "@anthropic-ai/claude-code@$version" ;;
    @openai/codex) echo "@openai/codex@$version" ;;
  esac
  exit 0
fi
if [ "$1" = install ]; then touch "${state}"; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    writeFileSync(claude, "#!/usr/bin/env bash\nif [ \"$1\" = --version ]; then echo 'Claude Code 1.1.0'; exit 0; fi\nif [ \"$1\" = update ]; then exit 0; fi\nexit 0\n", { mode: 0o755 });
    chmodSync(claude, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("provider marked degraded; no automatic rollback");
  });

  it("fails the upgrade when the qualification runner itself fails", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-upgrade-qualification-runner-fail-"));
    const npm = join(root, "npm");
    const node = join(root, "node");
    const state = join(root, "installed");
    const claude = join(root, "claude");

    writeFileSync(node, `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
exit 1
`, { mode: 0o755 });
    chmodSync(node, 0o755);
    writeFileSync(npm, `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = list ]; then
  version=1.0.0
  [ ! -f "${state}" ] || version=1.1.0
  pkg=""
  for arg in "$@"; do
    case "$arg" in
      @anthropic-ai/claude-code|@openai/codex) pkg="$arg" ;;
    esac
  done
  case "$pkg" in
    @anthropic-ai/claude-code) echo "@anthropic-ai/claude-code@$version" ;;
    @openai/codex) echo "@openai/codex@$version" ;;
  esac
  exit 0
fi
if [ "$1" = install ]; then touch "${state}"; exit 0; fi
exit 0
`, { mode: 0o755 });
    chmodSync(npm, 0o755);
    writeFileSync(claude, "#!/usr/bin/env bash\nif [ \"$1\" = --version ]; then echo 'Claude Code 1.1.0'; exit 0; fi\nif [ \"$1\" = update ]; then exit 0; fi\nexit 0\n", { mode: 0o755 });
    chmodSync(claude, 0o755);

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--clis-only"], {
      encoding: "utf8",
      env: { ...process.env, NODE_BIN: node, CLAUDE_COMMAND: claude, PATH: `${root}:${process.env.PATH}` },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("qualification runner failed");
  });
});
