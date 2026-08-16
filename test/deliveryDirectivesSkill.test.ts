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

  it("keeps release publication separate from deployment", () => {
    const skill = readFileSync("skills/delivery-directives/SKILL.md", "utf8");

    expect(skill).toContain("## `release it`");
    expect(skill).toContain("## `deploy it`");
    expect(skill).toContain("It does **not** authorize production deployment");
    expect(skill).toContain("Stop after publication and release verification");
    expect(skill).toContain("It does **not** authorize publishing a new release");
    expect(skill).toContain("already-published or otherwise explicitly approved release identity");
    expect(skill).toContain("post-deploy verification and acceptance checks");
  });

  it("keeps repository shorthand aligned with the skill", () => {
    const agents = readFileSync("AGENTS.md", "utf8");

    expect(agents).toContain('## Owner release shorthand — "release it"');
    expect(agents).toContain('## Owner deployment shorthand — "deploy it"');
    expect(agents).toContain('"release it" does **not** authorize production deployment');
    expect(agents).toContain('"deploy it" does **not** authorize publishing a new release');
    expect(agents).not.toContain('qualify, publish, deploy, and verify the current `main`');
  });

  it("keeps hotfix distinct from normal delivery and gates RCA on proven stability", () => {
    const skill = readFileSync("skills/delivery-directives/SKILL.md", "utf8");

    expect(skill).toContain("## `ship it`");
    expect(skill).toContain("## `release it`");
    expect(skill).toContain("## `hotfix`");
    expect(skill).toContain("restore production or a release-blocking qualification as an emergency");
    expect(skill).toContain("smallest safe change");
    expect(skill).toContain("Emergency status is not permission to bypass them");
    expect(skill).toContain("Do not create the RCA issue until stability is proven");
    expect(skill).toContain("impact and timeline");
    expect(skill).toContain("why existing tests/detection/controls did not prevent it");
    expect(skill).toContain("Recommend a separate long-term fix only when the evidence shows one is warranted");
    expect(skill).toContain("normal issue and `ship it` path");
  });
});
