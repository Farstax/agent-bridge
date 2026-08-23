import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths, verifySkillGlobal } from "../src/skills.js";
import { projectUserSkillGlobal } from "../src/userSkills.js";

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const path = join(tmpdir(), `agent-bridge-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function writeSkill(skillDir: string, name: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: User-authored skill used for projection testing.\n---\n\n# ${name}\n`,
  );
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("user skill projection", () => {
  it("registers a canonical user skill and reuses native provider projection", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(paths.agentsSkillsDir, "my-review"), "my-review");

    projectUserSkillGlobal("my-review", {
      homeDir: home,
      repoRoot,
      now: new Date("2026-08-23T21:00:00.000Z"),
    });

    expect(readlinkSync(join(paths.codexSkillsDir, "my-review"))).toBe("../../.agents/skills/my-review");
    expect(readlinkSync(join(paths.geminiSkillsDir, "my-review"))).toBe("../../../.agents/skills/my-review");
    expect(readlinkSync(join(paths.claudeSkillsDir, "my-review"))).toBe("../../.agents/skills/my-review");
    expect(verifySkillGlobal("my-review", { homeDir: home }).ok).toBe(true);
  });

  it("repairs a missing managed projection by rerunning project-user", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(paths.agentsSkillsDir, "my-review"), "my-review");
    projectUserSkillGlobal("my-review", { homeDir: home, repoRoot });
    rmSync(join(paths.codexSkillsDir, "my-review"), { recursive: true, force: true });

    expect(verifySkillGlobal("my-review", { homeDir: home }).ok).toBe(false);
    projectUserSkillGlobal("my-review", { homeDir: home, repoRoot });

    expect(readlinkSync(join(paths.codexSkillsDir, "my-review"))).toBe("../../.agents/skills/my-review");
    expect(verifySkillGlobal("my-review", { homeDir: home }).ok).toBe(true);
  });

  it("rejects invalid names before resolving shared or native paths", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    expect(() => projectUserSkillGlobal("../escape", { homeDir: home, repoRoot })).toThrow(/invalid user skill name/i);
  });

  it("rejects a user skill whose name collides with a bundled skill", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(paths.agentsSkillsDir, "reserved-skill"), "reserved-skill");
    writeSkill(join(repoRoot, "skills", "reserved-skill"), "reserved-skill");

    expect(() => projectUserSkillGlobal("reserved-skill", { homeDir: home, repoRoot }))
      .toThrow(/bundled skill name/i);
    expect(existsSync(join(paths.codexSkillsDir, "reserved-skill"))).toBe(false);
  });

  it("fails closed instead of replacing an unrelated native skill path", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(paths.agentsSkillsDir, "my-review"), "my-review");
    writeSkill(join(paths.claudeSkillsDir, "my-review"), "my-review");

    expect(() => projectUserSkillGlobal("my-review", { homeDir: home, repoRoot }))
      .toThrow(/not this managed projection/i);
    expect(existsSync(join(paths.codexSkillsDir, "my-review"))).toBe(false);
  });

  it("fails closed on a corrupt lockfile instead of resetting other skill records", () => {
    const home = makeTempDir("user-skill-home");
    const repoRoot = makeTempDir("user-skill-repo");
    const paths = resolveSkillPaths(home);
    writeSkill(join(paths.agentsSkillsDir, "my-review"), "my-review");
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(paths.lockfilePath, "{broken");

    expect(() => projectUserSkillGlobal("my-review", { homeDir: home, repoRoot })).toThrow(/unable to parse skill lockfile/i);
    expect(readFileSync(paths.lockfilePath, "utf8")).toBe("{broken");
    expect(existsSync(join(paths.codexSkillsDir, "my-review"))).toBe(false);
  });
});
