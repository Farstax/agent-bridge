import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("risk strategy alias retirement", () => {
  it("converges current bundled skills from a legacy v3 home without an alias source", () => {
    const home = makeTempDir("home");
    const legacyRepo = makeTempDir("legacy-repo");
    const currentRepo = makeTempDir("current-repo");

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

    writeSkill(currentRepo, "requirements-to-acceptance", "Current bundled skill.\n");
    expect(existsSync(join(currentRepo, "skills", retiredAlias))).toBe(false);

    expect(() => installSkillGlobal("requirements-to-acceptance", {
      homeDir: home,
      repoRoot: currentRepo,
      force: true,
    })).not.toThrow();

    const migrated = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version: number;
      skills: Record<string, { ownership?: string }>;
    };
    expect(migrated.version).toBeGreaterThanOrEqual(4);
    expect(migrated.skills[retiredAlias].ownership).toBe("bundled");
    expect(migrated.skills["requirements-to-acceptance"].ownership).toBe("bundled");
  });
});
