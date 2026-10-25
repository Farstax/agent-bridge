import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listLocalCatalog } from "../src/skills.js";

describe("independent review remains the only bundled review path", () => {
  it("retires the Advisor executable and Skill without removing release-readiness-review", () => {
    const catalog = listLocalCatalog().map((entry) => entry.name);
    expect(catalog).toContain("release-readiness-review");
    expect(catalog).not.toContain("advisor");
    expect(existsSync("bin/agent-bridge-advisor")).toBe(false);
    expect(existsSync("scripts/agent-bridge-advisor.ts")).toBe(false);

    const reviewSkill = readFileSync("skills/release-readiness-review/SKILL.md", "utf8");
    expect(reviewSkill).toContain("repository read/search tools");
    expect(reviewSkill).toContain("different available provider");
    expect(reviewSkill).not.toContain("AGENT_BRIDGE_ADVISOR_COMMAND");

    const debuggingSkill = readFileSync("skills/systematic-debugging/SKILL.md", "utf8");
    expect(debuggingSkill).not.toContain("Advisor escalation");
  });
});
