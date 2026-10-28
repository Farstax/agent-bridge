import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkillGlobal, reconcileBundledSkills, resolveSkillPaths } from "../src/skills.js";
import { cleanupRoots, createFixture, prepareImmutableRelease, runRollout } from "./support/rolloutFixture.js";

const temporary: string[] = [];
function makeDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `reconcile-${label}-`));
  temporary.push(dir);
  return dir;
}
function writeSkill(repo: string, name: string, body: string): void {
  const dir = join(repo, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${name} tests.\n---\n\n${body}\n`);
}
function lock(home: string): { skills: Record<string, { ownership?: string; skillFolderHash?: string }> } {
  return JSON.parse(readFileSync(resolveSkillPaths(home).lockfilePath, "utf8"));
}

afterEach(() => {
  cleanupRoots();
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe("bundled Skill reconciliation", () => {
  it("updates a stale bundled copy to the running release and keeps its projections", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    writeSkill(repo, "ui-engineering", "Version one.");
    installSkillGlobal("ui-engineering", { homeDir: home, repoRoot: repo });
    writeSkill(repo, "ui-engineering", "Version two with Playwright first use.");

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.updated).toEqual(["ui-engineering"]);
    expect(result.errors).toEqual([]);
    const paths = resolveSkillPaths(home);
    expect(readFileSync(join(paths.agentsSkillsDir, "ui-engineering", "SKILL.md"), "utf8")).toContain("Playwright first use");
    expect(lstatSync(join(paths.claudeSkillsDir, "ui-engineering")).isSymbolicLink()).toBe(true);
    expect(lock(home).skills["ui-engineering"].ownership).toBe("bundled");
  });

  it("is idempotent and installs nothing that was not already installed", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    writeSkill(repo, "installed-skill", "One.");
    writeSkill(repo, "new-bundled-skill", "Not installed on this host.");
    installSkillGlobal("installed-skill", { homeDir: home, repoRoot: repo });

    expect(reconcileBundledSkills({ homeDir: home, repoRoot: repo })).toMatchObject({ updated: [], retired: [], errors: [] });
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "new-bundled-skill"))).toBe(false);
  });

  it("never overwrites a user-owned Skill that shares a bundled name", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    const userRepo = makeDir("user-repo");
    writeSkill(userRepo, "writer", "My own writer skill.");
    installSkillGlobal("writer", { homeDir: home, repoRoot: userRepo, ownership: "user" });
    writeSkill(repo, "writer", "Bundled writer skill.");

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.userOwned).toEqual(["writer"]);
    expect(result.updated).toEqual([]);
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "writer", "SKILL.md"), "utf8")).toContain("My own writer skill.");
  });

  it("leaves a bundled copy that was edited after install", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    writeSkill(repo, "manage-mcp", "Original.");
    installSkillGlobal("manage-mcp", { homeDir: home, repoRoot: repo });
    const installed = join(resolveSkillPaths(home).agentsSkillsDir, "manage-mcp", "SKILL.md");
    writeFileSync(installed, `${readFileSync(installed, "utf8")}\nLocal operator note.\n`);
    writeSkill(repo, "manage-mcp", "Release update.");

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.locallyModified).toEqual(["manage-mcp"]);
    expect(readFileSync(installed, "utf8")).toContain("Local operator note.");
  });

  it("retires a bundled-owned Skill removed from the catalog but not an unknown user Skill", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    const oldRepo = makeDir("old-repo");
    writeSkill(oldRepo, "advisor", "Retired.");
    writeSkill(oldRepo, "custom-bundled", "Gone from catalog but not a retired name.");
    installSkillGlobal("advisor", { homeDir: home, repoRoot: oldRepo });
    installSkillGlobal("custom-bundled", { homeDir: home, repoRoot: oldRepo });

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.retired).toEqual(["advisor"]);
    const paths = resolveSkillPaths(home);
    expect(existsSync(join(paths.agentsSkillsDir, "advisor"))).toBe(false);
    expect(existsSync(join(paths.agentsSkillsDir, "custom-bundled"))).toBe(true);
  });

  it("copies from a read-only release so the next release can replace and retire them", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    writeSkill(repo, "ui-engineering", "Release one.");
    execFileSync("chmod", ["-R", "a-w", repo]);
    try {
      installSkillGlobal("ui-engineering", { homeDir: home, repoRoot: repo, linkMode: "copy" });
      const second = makeDir("repo2");
      writeSkill(second, "ui-engineering", "Release two.");
      execFileSync("chmod", ["-R", "a-w", second]);
      try {
        expect(reconcileBundledSkills({ homeDir: home, repoRoot: second })).toMatchObject({ updated: ["ui-engineering"], errors: [] });
        const third = makeDir("repo3");
        writeSkill(third, "ui-engineering", "Release three.");
        expect(reconcileBundledSkills({ homeDir: home, repoRoot: third })).toMatchObject({ updated: ["ui-engineering"], errors: [] });
        expect(reconcileBundledSkills({ homeDir: home, repoRoot: makeDir("empty") }).errors).toEqual([]);
      } finally {
        execFileSync("chmod", ["-R", "u+w", second]);
      }
    } finally {
      execFileSync("chmod", ["-R", "u+w", repo]);
    }
  });

  it("keeps an edited retired Skill and a bundled copy with no recorded hash", () => {
    const home = makeDir("home");
    const oldRepo = makeDir("old-repo");
    const repo = makeDir("repo");
    writeSkill(oldRepo, "advisor", "Retired.");
    writeSkill(oldRepo, "manage-skills", "Old.");
    installSkillGlobal("advisor", { homeDir: home, repoRoot: oldRepo });
    installSkillGlobal("manage-skills", { homeDir: home, repoRoot: oldRepo });
    const paths = resolveSkillPaths(home);
    const advisor = join(paths.agentsSkillsDir, "advisor", "SKILL.md");
    writeFileSync(advisor, `${readFileSync(advisor, "utf8")}\nOperator edit.\n`);
    const record = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
    delete record.skills["manage-skills"].skillFolderHash;
    writeFileSync(paths.lockfilePath, JSON.stringify(record));
    writeSkill(repo, "manage-skills", "New.");

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.locallyModified.sort()).toEqual(["advisor", "manage-skills"]);
    expect(result.retired).toEqual([]);
    expect(readFileSync(advisor, "utf8")).toContain("Operator edit.");
    expect(readFileSync(join(paths.agentsSkillsDir, "manage-skills", "SKILL.md"), "utf8")).toContain("Old.");
  });

  it("reports an unreadable catalog entry without aborting the remaining Skills", () => {
    const home = makeDir("home");
    const repo = makeDir("repo");
    writeSkill(repo, "alpha", "One.");
    writeSkill(repo, "beta", "One.");
    installSkillGlobal("alpha", { homeDir: home, repoRoot: repo });
    installSkillGlobal("beta", { homeDir: home, repoRoot: repo });
    writeSkill(repo, "beta", "Two.");
    writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), "no frontmatter");

    const result = reconcileBundledSkills({ homeDir: home, repoRoot: repo });

    expect(result.errors.some((entry) => entry.startsWith("alpha:"))).toBe(true);
    expect(result.updated).toEqual(["beta"]);
  });
});

describe("guarded rollout reconciles bundled Skills after acceptance", () => {
  function stubSkillManager(releaseDir: string, exitCode: number, recordTo: string): void {
    execFileSync("chmod", ["-R", "u+w", releaseDir]);
    // The fixture release links node_modules to the real tree. Replace the link so the stub never writes through it.
    rmSync(join(releaseDir, "node_modules"), { recursive: true, force: true });
    mkdirSync(join(releaseDir, "node_modules/tsx/dist"), { recursive: true });
    mkdirSync(join(releaseDir, "scripts"), { recursive: true });
    writeFileSync(join(releaseDir, "node_modules/tsx/dist/cli.mjs"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(recordTo)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME, shared: process.env.SHARED_MEMORY_HOME }) + "\\n");\nprocess.exit(${exitCode});\n`);
    writeFileSync(join(releaseDir, "scripts/skill-manager.ts"), "// stub\n");
    execFileSync("chmod", ["-R", "a-w", releaseDir]);
  }

  it("runs reconcile-bundled as the runtime user from the accepted release", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const record = join(fixture.root, "skill-manager-calls.jsonl");
    stubSkillManager(join(fixture.root, "releases", fixture.expectedCommit), 0, record);
    const home = join(fixture.root, "runtime-home");
    mkdirSync(home, { recursive: true });

    const result = runRollout(fixture, undefined, undefined, { AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: home });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("bundled skill reconciliation complete");
    const calls = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([{ argv: [expect.stringMatching(/scripts\/skill-manager\.ts$/), "reconcile-bundled"], home, shared: home }]);
  }, 30_000);

  it("does not fail an accepted rollout when reconciliation fails", () => {
    const failing = createFixture();
    prepareImmutableRelease(failing, failing.previousCommit);
    stubSkillManager(join(failing.root, "releases", failing.expectedCommit), 1, join(failing.root, "calls.jsonl"));
    const failed = runRollout(failing, undefined, undefined, { AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: failing.root });
    expect(failed.status, `${failed.stdout}\n${failed.stderr}`).toBe(0);
    expect(`${failed.stdout}\n${failed.stderr}`).toContain("bundled skill reconciliation failed (non-fatal)");
  }, 30_000);

  it("skips quietly when the release has no skill manager", () => {
    const absent = createFixture();
    prepareImmutableRelease(absent, absent.previousCommit);
    const skipped = runRollout(absent, undefined, undefined, { AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: absent.root });
    expect(skipped.status, `${skipped.stdout}\n${skipped.stderr}`).toBe(0);
    expect(`${skipped.stdout}\n${skipped.stderr}`).toContain("bundled skill reconciliation skipped reason=skill_manager_unavailable");
  }, 30_000);
});
