import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkillGlobal, resolveSkillPaths } from "../src/skills.js";

const tempDirs: string[] = [];
const retiredAlias = "risk-based-test-strategy";

function makeTempDir(label: string): string {
  const path = join(tmpdir(), `agent-bridge-risk-alias-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function writeSkill(repoRoot: string, name: string, suffix = ""): void {
  const skillDir = join(repoRoot, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Skill retirement regression fixture.\n---\n\n# ${name}\n${suffix}`,
  );
}

function writeExecutable(directory: string, name: string, body: string): void {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("risk strategy alias retirement", () => {
  it("runs the supported upgrade path from a legacy v3 home without an alias source", () => {
    const home = makeTempDir("home");
    const legacyRepo = makeTempDir("legacy-repo");
    const bin = makeTempDir("bin");

    writeSkill(legacyRepo, retiredAlias, "Legacy alias.\n");
    installSkillGlobal(retiredAlias, { homeDir: home, repoRoot: legacyRepo });

    const paths = resolveSkillPaths(home);
    const legacyLockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version?: number;
      skills: Record<string, { ownership?: string }>;
    };
    delete legacyLockfile.skills[retiredAlias].ownership;
    legacyLockfile.version = 3;
    writeFileSync(paths.lockfilePath, `${JSON.stringify(legacyLockfile, null, 2)}\n`);

    const upgradeScript = readFileSync("scripts/upgrade.sh", "utf8");
    const defaultMatch = upgradeScript.match(/^DEFAULT_AGENT_BRIDGE_SKILLS="([^"]+)"/m);
    expect(defaultMatch).not.toBeNull();
    const defaults = defaultMatch![1].split(",");
    expect(defaults).not.toContain(retiredAlias);
    expect(existsSync(join(process.cwd(), "skills", retiredAlias))).toBe(false);

    writeExecutable(bin, "getent", `
if [ "\${1:-}" = passwd ]; then
  printf '%s\\n' 'agentbridge-test:x:1000:1000::${home}:/bin/bash'
  exit 0
fi
exit 1
`);
    for (const command of ["npm", "codex", "agy", "claude"]) {
      writeExecutable(bin, command, "exit 0");
    }
    writeExecutable(bin, "sudo", `
if [ "\${1:-}" = tee ]; then
  cat >/dev/null
fi
exit 0
`);

    const result = spawnSync("bash", ["scripts/upgrade.sh"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        USER: "agentbridge-test",
        SUDO_USER: "agentbridge-test",
        NODE_BIN: process.execPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(retiredAlias);

    const migrated = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version: number;
      skills: Record<string, { ownership?: string }>;
    };
    expect(migrated.version).toBeGreaterThanOrEqual(4);
    expect(migrated.skills[retiredAlias].ownership).toBe("bundled");
    for (const skill of defaults) {
      expect(migrated.skills[skill]?.ownership).toBe("bundled");
    }
  });
});
