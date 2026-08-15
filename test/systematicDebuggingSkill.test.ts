import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listLocalCatalog } from "../src/skills.js";

describe("systematic debugging skill", () => {
  it("is bundled, installed by default, and keeps the authority boundary generic", () => {
    const skill = readFileSync("skills/systematic-debugging/SKILL.md", "utf8");
    const license = readFileSync("skills/systematic-debugging/LICENSE", "utf8");
    const pythonInstaller = readFileSync("scripts/agent-bridge-install.py", "utf8");
    const shellInstaller = readFileSync("scripts/install.sh", "utf8");
    const upgradeScript = readFileSync("scripts/upgrade.sh", "utf8");

    expect(listLocalCatalog().map((entry) => entry.name)).toContain("systematic-debugging");
    for (const source of [pythonInstaller, shellInstaller, upgradeScript]) {
      expect(source).toContain("systematic-debugging");
    }

    expect(skill).toMatch(/evidence/i);
    expect(skill).toMatch(/reproduce/i);
    expect(skill).toMatch(/hypothes/i);
    expect(skill).toMatch(/root cause/i);
    expect(skill).toMatch(/smallest justified fix/i);
    expect(skill).toMatch(/verify/i);
    expect(skill).toMatch(/Advisor/i);
    expect(skill).toMatch(/goal, constraints, observations,\s+hypotheses tested, attempted actions, measured outcomes/i);
    expect(skill).toMatch(/evidence[\s\S]*authority|authority[\s\S]*evidence/i);
    expect(skill).toMatch(/does not grant|does not authorize|authority/i);
    expect(skill).toMatch(/adapted from.*systematic-debugging/i);
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Jesse Vincent/);
    expect(skill).not.toMatch(/Farstax|customer.health|customer health/i);
  });
});
