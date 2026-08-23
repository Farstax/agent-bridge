/**
 * PURPOSE: Project user-authored skills from the canonical shared skill store into native provider skill directories.
 * INPUTS: A user skill name, shared home directory, bundled-skill catalog root, and projection link mode.
 * OUTPUTS: Existing shared skill registration plus native CLI projections managed by the shared skill manager.
 * NEIGHBORS: src/skills.ts, scripts/skill-manager.ts, skills/manage-skills/SKILL.md
 * LOGIC: Reject bundled-name and unmanaged-native-path collisions, then reuse installSkillGlobal against ~/.agents as the source root.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  hashDirectory,
  installSkillGlobal,
  listLocalCatalog,
  resolveSkillPaths,
  type SkillLinkMode,
} from "./skills.js";

export interface ProjectUserSkillOptions {
  homeDir?: string;
  repoRoot?: string;
  linkMode?: SkillLinkMode;
  now?: Date;
}

export function projectUserSkillGlobal(skillName: string, options: ProjectUserSkillOptions = {}): void {
  const paths = resolveSkillPaths(options.homeDir);
  const sharedDir = join(paths.agentsSkillsDir, skillName);
  const linkMode = options.linkMode ?? "symlink";

  if (linkMode !== "symlink" && linkMode !== "copy") throw new Error(`Invalid link mode: ${linkMode}`);
  if (!existsSync(sharedDir)) throw new Error(`User skill is missing from canonical shared storage: ${sharedDir}`);
  if (listLocalCatalog(options.repoRoot).some((entry) => entry.name === skillName)) {
    throw new Error(`Refusing to project user skill with bundled skill name: ${skillName}`);
  }

  for (const nativeDir of [paths.codexSkillsDir, paths.geminiSkillsDir, paths.claudeSkillsDir]) {
    assertNativeProjectionCompatible(join(nativeDir, skillName), sharedDir, linkMode);
  }

  // installSkillGlobal already owns validation, lockfile metadata, atomic writes,
  // and provider-native projection. Point its source root at ~/.agents so the
  // existing canonical user skill is registered without copying it elsewhere.
  installSkillGlobal(skillName, {
    repoRoot: join(paths.homeDir, ".agents"),
    homeDir: paths.homeDir,
    force: true,
    linkMode,
    now: options.now,
  });
}

function assertNativeProjectionCompatible(nativePath: string, sharedDir: string, linkMode: SkillLinkMode): void {
  let stat;
  try {
    stat = lstatSync(nativePath);
  } catch {
    return;
  }

  if (linkMode === "symlink" && stat.isSymbolicLink()) {
    try {
      if (resolve(dirname(nativePath), readlinkSync(nativePath)) === resolve(sharedDir)) return;
    } catch {
      // Fall through to the collision error below.
    }
  }

  if (linkMode === "copy" && stat.isDirectory()) {
    try {
      if (hashDirectory(nativePath) === hashDirectory(sharedDir)) return;
    } catch {
      // Fall through to the collision error below.
    }
  }

  throw new Error(`Native skill path already exists and is not this managed projection: ${nativePath}`);
}
