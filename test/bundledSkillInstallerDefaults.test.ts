import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { listLocalCatalog } from "../src/skills.js";

describe("bundled skill installer defaults", () => {
  for (const scriptPath of ["scripts/install.sh", "scripts/upgrade.sh"]) {
    it(`keeps every bundled Skill in ${scriptPath}`, () => {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("DEFAULT_AGENT_BRIDGE_SKILLS");
      for (const { name } of listLocalCatalog()) {
        expect(script).toContain(name);
      }
    });
  }
});
