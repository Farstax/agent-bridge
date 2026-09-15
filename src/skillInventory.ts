/**
 * PURPOSE: Expose a deterministic read-only view of the canonical installed Skill set.
 * INPUTS: The shared Skill lockfile and canonical ~/.agents/skills content.
 * OUTPUTS: Stable Skill identity plus intrinsic SKILL.md metadata only.
 * NEIGHBORS: src/skills.ts, scripts/skill-manager.ts, src/skillCollections.ts, src/userSkills.ts
 * LOGIC: Intersects registered canonical Skills with validated shared Skill definitions; provider projections and lifecycle metadata never shape the public result.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listLocalCatalog, resolveSkillPaths } from "./skills.js";

export interface InstalledSkillInventoryEntry {
  id: string;
  description: string;
}

export interface InstalledSkillInventoryOptions {
  homeDir?: string;
}

export function listInstalledSkillInventory(
  options: InstalledSkillInventoryOptions = {},
): InstalledSkillInventoryEntry[] {
  const paths = resolveSkillPaths(options.homeDir);
  const registered = readRegisteredSkillIds(paths.lockfilePath);
  if (registered.size === 0) return [];

  return listLocalCatalog(join(paths.homeDir, ".agents"))
    .filter((entry) => registered.has(entry.name))
    .map((entry) => ({ id: entry.name, description: entry.description }));
}

function readRegisteredSkillIds(lockfilePath: string): Set<string> {
  if (!existsSync(lockfilePath)) return new Set();

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockfilePath, "utf8")) as unknown;
  } catch {
    throw new Error(`Unable to parse skill lockfile: ${lockfilePath}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Unable to parse skill lockfile: ${lockfilePath}`);
  }

  const skills = (parsed as { skills?: unknown }).skills;
  if (skills === undefined) return new Set();
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
    throw new Error(`Unable to parse skill lockfile: ${lockfilePath}`);
  }

  const ids: string[] = [];
  for (const [id, record] of Object.entries(skills)) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Unable to parse skill lockfile: ${lockfilePath}`);
    }
    ids.push(id);
  }
  return new Set(ids);
}
