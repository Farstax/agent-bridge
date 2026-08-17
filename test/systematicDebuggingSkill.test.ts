import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listLocalCatalog } from "../src/skills.js";

describe("systematic debugging skill", () => {
  it("is bundled and installed by default", () => {
    const license = readFileSync("skills/systematic-debugging/LICENSE", "utf8");
    const pythonInstaller = readFileSync("scripts/agent-bridge-install.py", "utf8");
    const shellInstaller = readFileSync("scripts/install.sh", "utf8");
    const upgradeScript = readFileSync("scripts/upgrade.sh", "utf8");

    expect(listLocalCatalog().map((entry) => entry.name)).toContain("systematic-debugging");
    for (const source of [pythonInstaller, shellInstaller, upgradeScript]) {
      expect(source).toContain("systematic-debugging");
    }
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Jesse Vincent/);
  });
});
