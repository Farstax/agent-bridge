import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const skill = readFileSync("skills/ui-engineering/SKILL.md", "utf8");

describe("ui engineering skill", () => {
  it("uses repository design authority and a local-first composition path", () => {
    expect(skill).toMatch(/repository(?:-owned)? design/i);
    expect(skill).toMatch(/reuse local/i);
    expect(skill).toMatch(/approved external/i);
  });

  it("adapts imported patterns into the local system instead of copying them blindly", () => {
    expect(skill).toMatch(/adapt/i);
    expect(skill).toMatch(/tokens/i);
    expect(skill).toMatch(/local primitive/i);
  });

  it("keeps rendered responsive verification as the completion boundary", () => {
    expect(skill).toMatch(/mobile\/desktop/i);
    expect(skill).toMatch(/rendered visual state/i);
    expect(skill).toMatch(/visual consistency/i);
  });
});
