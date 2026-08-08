import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSharedSkillsHomeDir,
  hashDirectory,
  installSkillGlobal,
  listLocalCatalog,
  resolveSkillPaths,
  uninstallSkillGlobal,
  verifySkillGlobal,
} from "../src/skills.js";

const tempHomes: string[] = [];

function makeHome(): string {
  const home = join(tmpdir(), `agent-bridge-skills-${process.pid}-${tempHomes.length}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  tempHomes.push(home);
  return home;
}

function writeSkill(repoRoot: string, name: string, description: string): string {
  const skillDir = join(repoRoot, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return skillDir;
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("shared skills catalog", () => {
  it("lists bundled SDLC skills", () => {
    const names = listLocalCatalog().map((entry) => entry.name);
    expect(names).toContain("requirements-to-acceptance");
    expect(names).toContain("risk-based-test-strategy");
    expect(names).toContain("red-green-refactor-tdd");
    expect(names).toContain("release-readiness-review");
  });

  it("accepts a standards-compatible SKILL.md without skill.json", () => {
    const repoRoot = makeHome();
    const skillDir = writeSkill(repoRoot, "portable-skill", "Portable skill used for compatibility testing.");

    expect(listLocalCatalog(repoRoot)).toEqual([{
      name: "portable-skill",
      version: "unversioned",
      description: "Portable skill used for compatibility testing.",
      path: skillDir,
    }]);
  });

  it("treats SKILL.md as authoritative while retaining optional legacy version metadata", () => {
    const repoRoot = makeHome();
    const skillDir = writeSkill(repoRoot, "portable-skill", "Description from the portable skill.");
    writeFileSync(join(skillDir, "skill.json"), `${JSON.stringify({
      name: "portable-skill",
      version: "2.3.4",
      description: "Legacy sidecar description.",
    }, null, 2)}\n`);

    expect(listLocalCatalog(repoRoot)).toEqual([{
      name: "portable-skill",
      version: "2.3.4",
      description: "Description from the portable skill.",
      path: skillDir,
    }]);
  });

  it("rejects a SKILL.md whose name does not match its directory", () => {
    const repoRoot = makeHome();
    const skillDir = join(repoRoot, "skills", "portable-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: another-skill\ndescription: Valid description.\n---\n");

    expect(() => listLocalCatalog(repoRoot)).toThrow(/name does not match folder/i);
  });

  it("keeps the bundled skills list in install.sh as the default", () => {
    const installScript = readFileSync("scripts/install.sh", "utf8");
    for (const name of listLocalCatalog().map((entry) => entry.name)) {
      expect(installScript).toContain(name);
    }
    expect(installScript).toContain("DEFAULT_AGENT_BRIDGE_SKILLS");
  });

  it("prefers SHARED_MEMORY_HOME for path resolution", () => {
    expect(getSharedSkillsHomeDir({ SHARED_MEMORY_HOME: "/tmp/shared", HOME: "/tmp/home" })).toBe("/tmp/shared");
  });
});

describe("shared skills install", () => {
  it("installs a standards-compatible skill without skill.json and preserves projection verification", () => {
    const repoRoot = makeHome();
    const home = makeHome();
    writeSkill(repoRoot, "portable-skill", "Portable skill used for compatibility testing.");

    installSkillGlobal("portable-skill", { repoRoot, homeDir: home, now: new Date("2026-08-08T20:00:00.000Z") });

    const paths = resolveSkillPaths(home);
    const sharedSkill = join(paths.agentsSkillsDir, "portable-skill");
    expect(existsSync(join(sharedSkill, "SKILL.md"))).toBe(true);
    expect(existsSync(join(sharedSkill, "skill.json"))).toBe(false);
    expect(readlinkSync(join(paths.codexSkillsDir, "portable-skill"))).toBe("../../.agents/skills/portable-skill");
    expect(readlinkSync(join(paths.geminiSkillsDir, "portable-skill"))).toBe("../../../.agents/skills/portable-skill");
    expect(readlinkSync(join(paths.claudeSkillsDir, "portable-skill"))).toBe("../../.agents/skills/portable-skill");
    expect(verifySkillGlobal("portable-skill", { homeDir: home }).ok).toBe(true);
  });

  it("installs a skill into shared storage and native CLI symlinks", () => {
    const home = makeHome();
    installSkillGlobal("requirements-to-acceptance", { homeDir: home, now: new Date("2026-05-21T08:30:00.000Z") });

    const paths = resolveSkillPaths(home);
    const sharedSkill = join(paths.agentsSkillsDir, "requirements-to-acceptance");
    expect(existsSync(join(sharedSkill, "SKILL.md"))).toBe(true);
    expect(readlinkSync(join(paths.codexSkillsDir, "requirements-to-acceptance"))).toBe("../../.agents/skills/requirements-to-acceptance");
    expect(readlinkSync(join(paths.geminiSkillsDir, "requirements-to-acceptance"))).toBe("../../../.agents/skills/requirements-to-acceptance");
    expect(readlinkSync(join(paths.claudeSkillsDir, "requirements-to-acceptance"))).toBe("../../.agents/skills/requirements-to-acceptance");

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
    expect(lockfile.skills["requirements-to-acceptance"].linkMode).toBe("symlink");
    expect(lockfile.skills["requirements-to-acceptance"].skillFolderHash).toBe(hashDirectory(sharedSkill));
  });

  it("supports copy mode for native CLI folders", () => {
    const home = makeHome();
    installSkillGlobal("red-green-refactor-tdd", { homeDir: home, linkMode: "copy", now: new Date("2026-05-21T08:30:00.000Z") });

    const paths = resolveSkillPaths(home);
    expect(existsSync(join(paths.codexSkillsDir, "red-green-refactor-tdd", "SKILL.md"))).toBe(true);
    expect(hashDirectory(join(paths.codexSkillsDir, "red-green-refactor-tdd"))).toBe(hashDirectory(join(paths.agentsSkillsDir, "red-green-refactor-tdd")));

    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
    expect(lockfile.skills["red-green-refactor-tdd"].linkMode).toBe("copy");
  });

  it("aborts on an existing shared skill unless forced", () => {
    const home = makeHome();
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    expect(() => installSkillGlobal("requirements-to-acceptance", { homeDir: home })).toThrow(/already installed/);
    expect(() => installSkillGlobal("requirements-to-acceptance", { homeDir: home, force: true })).not.toThrow();
  });

  it("backs up a corrupt lockfile when force installing", () => {
    const home = makeHome();
    const paths = resolveSkillPaths(home);
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(paths.lockfilePath, "{not-json");

    expect(() => installSkillGlobal("requirements-to-acceptance", { homeDir: home })).toThrow(/Unable to parse/);
    installSkillGlobal("requirements-to-acceptance", { homeDir: home, force: true });

    expect(JSON.parse(readFileSync(paths.lockfilePath, "utf8")).skills["requirements-to-acceptance"]).toBeDefined();
    expect(existsSync(paths.lockfilePath)).toBe(true);
  });
});

describe("shared skills verify and uninstall", () => {
  it("reports missing native links and can repair them", () => {
    const home = makeHome();
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    const paths = resolveSkillPaths(home);
    rmSync(join(paths.codexSkillsDir, "requirements-to-acceptance"), { recursive: true, force: true });

    expect(verifySkillGlobal("requirements-to-acceptance", { homeDir: home }).ok).toBe(false);
    const repaired = verifySkillGlobal("requirements-to-acceptance", { homeDir: home, fix: true });
    expect(repaired.repaired.length).toBe(1);
    expect(verifySkillGlobal("requirements-to-acceptance", { homeDir: home }).ok).toBe(true);
  });

  it("repairs stale symlinks with verify --fix", () => {
    const home = makeHome();
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    const paths = resolveSkillPaths(home);
    rmSync(join(paths.codexSkillsDir, "requirements-to-acceptance"), { recursive: true, force: true });
    symlinkSync("/tmp/not-the-skill", join(paths.codexSkillsDir, "requirements-to-acceptance"), "dir");

    expect(verifySkillGlobal("requirements-to-acceptance", { homeDir: home }).ok).toBe(false);
    expect(verifySkillGlobal("requirements-to-acceptance", { homeDir: home, fix: true }).repaired.length).toBe(1);
    expect(readlinkSync(join(paths.codexSkillsDir, "requirements-to-acceptance"))).toBe("../../.agents/skills/requirements-to-acceptance");
  });

  it("uninstalls artifacts while preserving unrelated lockfile fields", () => {
    const home = makeHome();
    installSkillGlobal("requirements-to-acceptance", { homeDir: home });
    const paths = resolveSkillPaths(home);
    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
    lockfile.dismissed = { findSkillsPrompt: true };
    writeFileSync(paths.lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    uninstallSkillGlobal("requirements-to-acceptance", { homeDir: home });

    const updated = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
    expect(updated.skills["requirements-to-acceptance"]).toBeUndefined();
    expect(updated.dismissed.findSkillsPrompt).toBe(true);
    expect(existsSync(join(paths.agentsSkillsDir, "requirements-to-acceptance"))).toBe(false);
    expect(existsSync(join(paths.codexSkillsDir, "requirements-to-acceptance"))).toBe(false);
  });
});
