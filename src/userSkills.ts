/**
 * PURPOSE: Project user-authored skills from the canonical shared skill store into native provider skill directories.
 * INPUTS: A validated user skill name, shared home directory, and bundled-skill catalog root.
 * OUTPUTS: Existing shared skill registration plus native CLI symlink projections managed by the shared skill manager.
 * NEIGHBORS: src/skills.ts, scripts/skill-manager.ts, skills/manage-skills/SKILL.md
 * LOGIC: Fail closed on invalid names, corrupt lock state, bundled-name collisions, or unmanaged native paths, then reuse installSkillGlobal against ~/.agents.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installSkillGlobal, listLocalCatalog, resolveSkillPaths } from "./skills.js";

export interface ProjectUserSkillOptions {
  homeDir?: string;
  repoRoot?: string;
  now?: Date;
}

export function projectUserSkillGlobal(skillName: string, options: ProjectUserSkillOptions = {}): void {
  validateUserSkillName(skillName);
  const paths = resolveSkillPaths(options.homeDir);
  const sharedDir = join(paths.agentsSkillsDir, skillName);

  if (!existsSync(sharedDir)) throw new Error(`User skill is missing from canonical shared storage: ${sharedDir}`);
  assertLockfileReadable(paths.lockfilePath);
  if (listLocalCatalog(options.repoRoot).some((entry) => entry.name === skillName)) {
    throw new Error(`Refusing to project user skill with bundled skill name: ${skillName}`);
  }

  for (const nativeDir of [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir]) {
    assertNativeProjectionCompatible(join(nativeDir, skillName), sharedDir);
  }

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
}

function validateUserSkillName(skillName: string): void {
  if (skillName.length < 1 || skillName.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName)) {
    throw new Error(`Invalid user skill name: ${skillName}`);
  }
}

function assertLockfileReadable(lockfilePath: string): void {
  if (!existsSync(lockfilePath)) return;
  try {
    JSON.parse(readFileSync(lockfilePath, "utf8"));
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
