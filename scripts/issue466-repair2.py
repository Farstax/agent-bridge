#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected 1 occurrence, found {count}")
    return text.replace(old, new, 1)

# The existing exact-release regression owns the default skill inventory.
path = "test/initialInstall.test.ts"
s = read(path)
s = replace_once(s,
'''      "git-sandbox",\n      "cli-auth-telegram",\n    ];''',
'''      "git-sandbox",\n      "cli-auth-telegram",\n      "autonomous-work",\n    ];''', "initial installer expected skill inventory")
write(path, s)

# Keep the new skill contract test on public filesystem/catalogue behavior rather
# than depending on a private helper export.
write("test/autonomousWorkSkill.test.ts", r'''import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("autonomous-work skill convergence (#466)", () => {
  it("is provider-neutral and teaches the approved Goal/Episode/Cycle/Run contract", () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, "skills", "autonomous-work", "skill.json"), "utf8"));
    expect(manifest.name).toBe("autonomous-work");
    const text = readFileSync(join(root, "skills", "autonomous-work", "SKILL.md"), "utf8");
    for (const term of ["Goal", "Episode", "Cycle", "Run", "current truth", "supervisorMessage", "frozen authority"]) expect(text).toContain(term);
    expect(text).not.toContain("Farstax");
    expect(text).not.toContain("Company runtime");
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
''')

print("issue #466 repair 2 applied")
