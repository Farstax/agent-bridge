import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ISSUE_554_SKILLS = ["manage-skills", "manage-mcp", "ui-engineering"];

describe("issue #554 bundled skill defaults", () => {
  for (const scriptPath of ["scripts/install.sh", "scripts/upgrade.sh"]) {
    it(`includes the new capability Skills in ${scriptPath}`, () => {
      const script = readFileSync(scriptPath, "utf8");
      expect(script).toContain("DEFAULT_AGENT_BRIDGE_SKILLS");
      for (const name of ISSUE_554_SKILLS) expect(script).toContain(name);
    });
  }
});
