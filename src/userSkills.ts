/**
 * PURPOSE: Project and remove user-authored skills through the canonical shared skill store without overwriting unrelated native provider content.
 * INPUTS: A validated user skill name, shared home directory, and bundled-skill catalog root.
 * OUTPUTS: Existing shared skill registration plus native CLI symlink projections managed by the shared skill manager.
 * NEIGHBORS: src/skills.ts, scripts/skill-manager.ts, skills/manage-skills/SKILL.md
 * LOGIC: Fail closed on invalid names, corrupt lock state, bundled-name collisions, or unmanaged native paths, then reuse the shared skill manager.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installSkillGlobal, listLocalCatalog, resolveSkillPaths, uninstallSkillGlobal } from "./skills.js";

export interface ProjectUserSkillOptions {
  homeDir?: string;
  repoRoot?: string;
  now?: Date;
}

export function projectUserSkillGlobal(skillName: string, options: ProjectUserSkillOptions = {}): void {
  const { paths, sharedDir } = preflightUserSkill(skillName, options, true);

  // installSkillGlobal already owns SKILL.md validation, lockfile metadata,
  // atomic writes, and provider-native projection. Point its source root at
  // ~/.agents so the canonical user skill is registered in place. User skills
  // intentionally use symlinks: copy mode cannot safely distinguish a stale
  // managed copy from unrelated user-owned native content after an edit.
  installSkillGlobal(skillName, {
    repoRoot: join(paths.homeDir, ".agents"),
    homeDir: paths.homeDir,
    force: true,
    linkMode: "symlink",
    now: options.now,
  });

  // Keep the local variable used in the preflight explicit for reviewability:
  // the native links projected above point back to this canonical directory.
  void sharedDir;
}

export function uninstallUserSkillGlobal(skillName: string, options: ProjectUserSkillOptions = {}): void {
  const { paths } = preflightUserSkill(skillName, options, true);
  uninstallSkillGlobal(skillName, { homeDir: paths.homeDir });
}

function preflightUserSkill(
  skillName: string,
  options: ProjectUserSkillOptions,
  requireSharedDir: boolean,
): { paths: ReturnType<typeof resolveSkillPaths>; sharedDir: string } {
  validateUserSkillName(skillName);
  const paths = resolveSkillPaths(options.homeDir);
  const sharedDir = join(paths.agentsSkillsDir, skillName);

  if (requireSharedDir && !existsSync(sharedDir)) {
    throw new Error(`User skill is missing from canonical shared storage: ${sharedDir}`);
  }
  assertLockfileReadable(paths.lockfilePath);
  if (listLocalCatalog(options.repoRoot).some((entry) => entry.name === skillName)) {
    throw new Error(`Refusing user-skill operation with bundled skill name: ${skillName}`);
  }

  for (const nativeDir of [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir]) {
    assertNativeProjectionCompatible(join(nativeDir, skillName), sharedDir);
  }

  return { paths, sharedDir };
}

function validateUserSkillName(skillName: string): void {
  if (skillName.length < 1 || skillName.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`Invalid user skill name: ${skillName}`);
  }
}

function assertLockfileReadable(lockfilePath: string): void {
  if (!existsSync(lockfilePath)) return;
  try {
    const parsed = JSON.parse(readFileSync(lockfilePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid lockfile root");
    const skills = (parsed as { skills?: unknown }).skills;
    if (skills !== undefined && (!skills || typeof skills !== "object" || Array.isArray(skills))) {
      throw new Error("invalid skills map");
    }
  } catch {
    throw new Error(`Unable to parse skill lockfile: ${lockfilePath}`);
  }
}

function assertNativeProjectionCompatible(nativePath: string, sharedDir: string): void {
  let stat;
  try {
    stat = lstatSync(nativePath);
  } catch {
    return;
  }

  if (stat.isSymbolicLink()) {
    try {
      if (resolve(dirname(nativePath), readlinkSync(nativePath)) === resolve(sharedDir)) return;
    } catch {
      // Fall through to the collision error below.
    }
  }

  throw new Error(`Native skill path already exists and is not this managed projection: ${nativePath}`);
}
