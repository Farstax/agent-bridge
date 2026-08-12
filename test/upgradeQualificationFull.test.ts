import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function script(path: string, content: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe("full CLI update qualification", () => {
  it("qualifies Agy after the updater observes its new installed version", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-full-update-qualification-"));
    const agyState = join(root, "agy-updated");
    const npmState = join(root, "npm-updated");
    const qualificationLog = join(root, "qualification.log");
    const claude = join(root, "claude");

    script(join(root, "node"), `
if [ "$1" = "-p" ]; then echo 24.0.0; exit 0; fi
printf '%s\\n' "$*" >> "${qualificationLog}"
exit 0
`);
    script(join(root, "npm"), `
if [ "$1" = list ]; then
  version=1.0.0
  [ ! -f "${npmState}" ] || version=1.1.0
  case "$2" in
    @anthropic-ai/claude-code) echo "@anthropic-ai/claude-code@$version" ;;
    @openai/codex) echo "@openai/codex@$version" ;;
  esac
  exit 0
fi
if [ "$1" = update ] && [ "$2" = -g ]; then touch "${npmState}"; exit 0; fi
if [ "$1" = run ]; then exit 0; fi
if [ "$1" = test ]; then exit 0; fi
if [ "$1" = install ]; then exit 0; fi
exit 0
`);
    script(join(root, "agy"), `
if [ "$1" = --version ]; then
  if [ -f "${agyState}" ]; then echo 'agy 1.1.13'; else echo 'agy 1.1.12'; fi
  exit 0
fi
exit 0
`);
    script(claude, `
if [ "$1" = --version ]; then echo 'Claude Code 1.1.12'; exit 0; fi
if [ "$1" = update ]; then exit 0; fi
exit 0
`);
    script(join(root, "curl"), `
printf '%s\\n' '#!/usr/bin/env bash' 'touch "${agyState}"'
`);
    script(join(root, "systemctl"), "exit 1\n");

    const result = spawnSync("bash", ["scripts/upgrade.sh", "--update"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_BIN: join(root, "node"),
        CLAUDE_COMMAND: claude,
        PATH: `${root}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const invocations = readFileSync(qualificationLog, "utf8");
    expect(invocations).toContain("provider-qualification.ts --provider agy --expected-version 1.1.13");
    expect(invocations).toContain("--previous-version 1.1.12");
  });
});
