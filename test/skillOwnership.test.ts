import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkillGlobal, resolveSkillPaths, uninstallSkillGlobal, verifySkillGlobal } from "../src/skills.js";
import { projectUserSkillGlobal } from "../src/userSkills.js";

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const path = join(tmpdir(), `agent-bridge-ownership-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function writeSkill(skillDir: string, name: string, suffix = ""): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Ownership regression skill.\n---\n\n# ${name}\n${suffix}`,
  );
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("skill ownership", () => {
  it("protects a legacy v3 user skill when a skipped future release adds the same bundled name", () => {
    const home = makeTempDir("legacy-user-home");
    const userRepo = makeTempDir("legacy-user-repo");
    const futureRepo = makeTempDir("future-repo");
    const paths = resolveSkillPaths(home);
    const canonical = join(paths.agentsSkillsDir, "customer-review");
    writeSkill(canonical, "customer-review", "User content.\n");
    projectUserSkillGlobal("customer-review", { homeDir: home, repoRoot: userRepo });

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version?: number;
      skills: Record<string, { ownership?: string }>;
    };
    delete lockfile.skills["customer-review"].ownership;
    lockfile.version = 3;
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
    const before = readFileSync(join(canonical, "SKILL.md"), "utf8");

    writeSkill(join(futureRepo, "skills", "customer-review"), "customer-review", "Bundled replacement.\n");
    expect(() => installSkillGlobal("customer-review", {
      homeDir: home,
      repoRoot: futureRepo,
      force: true,
    })).toThrow(/user-owned/i);
    expect(readFileSync(join(canonical, "SKILL.md"), "utf8")).toBe(before);
  });

  it("migrates a legacy bundled record using the frozen v4 baseline", () => {
    const home = makeTempDir("legacy-bundled-home");
    const repo = makeTempDir("legacy-bundled-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(repo, "skills", "advisor"), "advisor", "Version one.\n");
    installSkillGlobal("advisor", { homeDir: home, repoRoot: repo });

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version?: number;
      skills: Record<string, { ownership?: string }>;
    };
    delete lockfile.skills.advisor.ownership;
    lockfile.version = 3;
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
    writeSkill(join(repo, "skills", "advisor"), "advisor", "Version two.\n");

    expect(() => installSkillGlobal("advisor", { homeDir: home, repoRoot: repo, force: true })).not.toThrow();
    const migrated = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      version: number;
      skills: Record<string, { ownership?: string }>;
    };
    expect(migrated.version).toBeGreaterThanOrEqual(4);
    expect(migrated.skills.advisor.ownership).toBe("bundled");
  });

  it("does not let project-user take over a bundled-owned skill through a different catalog root", () => {
    const home = makeTempDir("bundled-owner-home");
    const bundledRepo = makeTempDir("bundled-owner-repo");
    const emptyRepo = makeTempDir("empty-user-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(bundledRepo, "skills", "release-review"), "release-review");
    installSkillGlobal("release-review", { homeDir: home, repoRoot: bundledRepo });

    expect(() => projectUserSkillGlobal("release-review", { homeDir: home, repoRoot: emptyRepo }))
      .toThrow(/bundled-owned/i);
    expect(existsSync(join(paths.agentsSkillsDir, "release-review"))).toBe(true);
  });

  it("generic uninstall and verify --fix do not mutate user-owned content", () => {
    const home = makeTempDir("generic-guard-home");
    const userRepo = makeTempDir("generic-guard-repo");
    const paths = resolveSkillPaths(home);
    const canonical = join(paths.agentsSkillsDir, "customer-review");
    const codexPath = join(paths.codexSkillsDir, "customer-review");
    writeSkill(canonical, "customer-review");
    projectUserSkillGlobal("customer-review", { homeDir: home, repoRoot: userRepo });

    expect(() => uninstallSkillGlobal("customer-review", { homeDir: home })).toThrow(/user-owned/i);
    expect(existsSync(canonical)).toBe(true);

    rmSync(codexPath, { recursive: true, force: true });
    writeSkill(codexPath, "customer-review", "Unrelated native content.\n");
    const repaired = verifySkillGlobal("customer-review", { homeDir: home, fix: true });
    expect(repaired.ok).toBe(false);
    expect(repaired.repaired).toEqual([]);
    expect(readFileSync(join(codexPath, "SKILL.md"), "utf8")).toContain("Unrelated native content.");
  });
});
