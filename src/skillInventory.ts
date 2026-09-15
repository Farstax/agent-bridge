/**
 * PURPOSE: Expose a deterministic read-only view of the canonical installed Skill set.
 * INPUTS: The shared Skill lockfile and canonical ~/.agents/skills content.
 * OUTPUTS: Stable Skill identity plus intrinsic SKILL.md metadata only.
 * NEIGHBORS: src/skills.ts, scripts/skill-manager.ts, src/skillCollections.ts, src/userSkills.ts
 * LOGIC: Intersects registered canonical Skills with validated shared Skill definitions; provider projections and lifecycle metadata never shape the public result.
 */

import { listRegisteredSkillCatalog } from "./skills.js";

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
  return listRegisteredSkillCatalog(options)
    .map((entry) => ({ id: entry.name, description: entry.description }));
}
