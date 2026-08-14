import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listLocalCatalog } from "../src/skills.js";

describe("delivery directives skill", () => {
  it("is bundled and included in the default install and upgrade skill sets", () => {
    expect(listLocalCatalog().map((entry) => entry.name)).toContain("delivery-directives");

    const installScript = readFileSync("scripts/install.sh", "utf8");
    const upgradeScript = readFileSync("scripts/upgrade.sh", "utf8");
    expect(installScript).toContain("DEFAULT_AGENT_BRIDGE_SKILLS");
    expect(upgradeScript).toContain("DEFAULT_AGENT_BRIDGE_SKILLS");
    expect(installScript).toContain("delivery-directives");
    expect(upgradeScript).toContain("delivery-directives");
  });
});
