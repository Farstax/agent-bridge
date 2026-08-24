import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installSkillGlobal,
  projectManagedSkillToCursor,
  resolveSkillPaths,
  verifySkillGlobal,
} from "../src/skills.js";


const tempDirs: string[] = [];
const skillManager = resolve(process.cwd(), "scripts/skill-manager.ts");
const tsxBin = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const skillName = "red-green-refactor-tdd";

function makeTempDir(label: string): string {
  const path = join(tmpdir(), `agent-bridge-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function runSkillManager(args: string[], home: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [tsxBin, skillManager, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        SHARED_MEMORY_HOME: home,
      },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
      status: typeof err.status === "number" ? err.status : 1,
    };
  }
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("skill-manager Cursor projection workflow", () => {
  it("documents project-cursor in usage", () => {
    const result = runSkillManager([], makeTempDir("cursor-skill-usage"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/project-cursor/);
    expect(result.stderr).toMatch(/--project-cursor/);
  });

  it("does not auto-project Cursor on ordinary install", () => {
    const home = makeTempDir("cursor-skill-install");
    const result = runSkillManager(["install", skillName, "--force"], home);
    expect(result.status).toBe(0);
    const paths = resolveSkillPaths(home);
    expect(existsSync(join(paths.claudeSkillsDir, skillName))).toBe(true);
    expect(existsSync(join(paths.cursorSkillsDir, skillName))).toBe(false);
  });

  it("projects Cursor when install --project-cursor is requested", () => {
    const home = makeTempDir("cursor-skill-install-flag");
    const result = runSkillManager(["install", skillName, "--force", "--project-cursor"], home);
    expect(result.status).toBe(0);
    const paths = resolveSkillPaths(home);
    expect(readlinkSync(join(paths.cursorSkillsDir, skillName))).toBe(`../../.agents/skills/${skillName}`);
    const lockfile = JSON.parse(readFileSync(paths.lockfilePath, "utf8")) as {
      skills: Record<string, { cursorProjected?: boolean }>;
    };
    expect(lockfile.skills[skillName]?.cursorProjected).toBe(true);
  });

  it("projects Cursor through the explicit project-cursor command", () => {
    const home = makeTempDir("cursor-skill-project-cmd");
    expect(runSkillManager(["install", skillName, "--force"], home).status).toBe(0);
    const projected = runSkillManager(["project-cursor", skillName], home);
    expect(projected.status).toBe(0);
    const paths = resolveSkillPaths(home);
    expect(existsSync(join(paths.cursorSkillsDir, skillName, "SKILL.md"))).toBe(true);
  });

  it("refuses to overwrite an unmanaged Cursor skill through project-cursor", () => {
    const home = makeTempDir("cursor-skill-collision");
    expect(runSkillManager(["install", skillName, "--force"], home).status).toBe(0);
    const paths = resolveSkillPaths(home);
    mkdirSync(join(paths.cursorSkillsDir, skillName), { recursive: true });
    writeFileSync(join(paths.cursorSkillsDir, skillName, "SKILL.md"), "# unmanaged\n");
    const result = runSkillManager(["project-cursor", skillName], home);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/not this managed projection/i);
    expect(readFileSync(join(paths.cursorSkillsDir, skillName, "SKILL.md"), "utf8")).toContain("unmanaged");
  });

  it("repairs a stale managed Cursor projection with verify --fix and preserves unmanaged content", () => {
    const home = makeTempDir("cursor-skill-verify-fix");
    installSkillGlobal(skillName, { homeDir: home, force: true, projectCursor: true });
    const paths = resolveSkillPaths(home);
    rmSync(join(paths.cursorSkillsDir, skillName), { recursive: true, force: true });
    mkdirSync(paths.cursorSkillsDir, { recursive: true });
    // stale symlink to the wrong target
    symlinkSync("../../.agents/skills/missing-skill", join(paths.cursorSkillsDir, skillName), "dir");

    expect(verifySkillGlobal(skillName, { homeDir: home }).ok).toBe(false);
    const repaired = verifySkillGlobal(skillName, { homeDir: home, fix: true });
    expect(repaired.ok).toBe(true);
    expect(repaired.repaired.some((path) => path.includes(".cursor/skills"))).toBe(true);
    expect(readlinkSync(join(paths.cursorSkillsDir, skillName))).toBe(`../../.agents/skills/${skillName}`);

    const collisionHome = makeTempDir("cursor-skill-verify-unmanaged");
    installSkillGlobal(skillName, { homeDir: collisionHome, force: true, projectCursor: true });
    const collisionPaths = resolveSkillPaths(collisionHome);
    rmSync(join(collisionPaths.cursorSkillsDir, skillName), { recursive: true, force: true });
    mkdirSync(join(collisionPaths.cursorSkillsDir, skillName), { recursive: true });
    writeFileSync(join(collisionPaths.cursorSkillsDir, skillName, "SKILL.md"), "# unmanaged\n");
    const blocked = verifySkillGlobal(skillName, { homeDir: collisionHome, fix: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.join("\n")).toMatch(/unmanaged Cursor skill path/i);
    expect(readFileSync(join(collisionPaths.cursorSkillsDir, skillName, "SKILL.md"), "utf8")).toContain("unmanaged");
  });
});
