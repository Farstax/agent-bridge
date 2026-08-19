import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("autonomous-work skill convergence (#466)", () => {
  it("is provider-neutral and teaches the approved Goal/Episode/Cycle/Run contract", () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "skills", "autonomous-work", "skill.json"), "utf8"));
    expect(manifest.name).toBe("autonomous-work");
    const text = readFileSync(join(root, "skills", "autonomous-work", "SKILL.md"), "utf8");
    for (const term of ["Goal", "Episode", "Cycle", "Run", "current truth", "frozen authority", "--notify", "continue", "done", "blocked"]) expect(text).toContain(term);
    expect(text).not.toContain("Farstax");
    expect(text).not.toContain("Company runtime");
    expect(text).not.toContain("supervisorMessage");
    expect(text).not.toContain("nextWakeReason");
    expect(text).not.toContain("Return JSON only");
  });

  it("converges the required skill on fresh install and --update even with a custom list", () => {
    const install = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const upgrade = readFileSync(join(process.cwd(), "scripts", "upgrade.sh"), "utf8");
    expect(install).toContain("autonomous-work");
    expect(upgrade).toContain("autonomous-work");
    expect(upgrade).toContain("[update] Converging shared skills");
    expect(install).toContain('skills_csv="${skills_csv},autonomous-work"');
    expect(upgrade).toContain('skills_csv="${skills_csv},autonomous-work"');
  });
});
