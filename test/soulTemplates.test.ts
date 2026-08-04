import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSoulTemplate, loadSoulTemplateCatalogue } from "../src/soulTemplates.js";

describe("soul template catalogue", () => {
  it("loads a validated catalogue with distinct supported use cases", () => {
    const catalogue = loadSoulTemplateCatalogue(process.cwd());
    expect(catalogue.schemaVersion).toBe(1);
    expect(catalogue.defaultTemplateId).toBe("operations-engineer");
    expect(catalogue.templates.map((template) => template.id)).toEqual([
      "operations-engineer",
      "companion",
      "minimal",
    ]);
    expect(new Set(catalogue.templates.map((template) => template.description)).size).toBe(3);
    for (const template of catalogue.templates) {
      expect(template.useCases.length).toBeGreaterThan(0);
      expect(template.content).toContain("## Identity");
      expect(template.content).toContain("## Tool Usage");
    }
  });

  it("keeps the standalone root SOUL byte-identical to the default template", () => {
    const catalogue = loadSoulTemplateCatalogue(process.cwd());
    const defaultTemplate = getSoulTemplate(catalogue, catalogue.defaultTemplateId);
    expect(readFileSync(join(process.cwd(), "SOUL.md"), "utf8")).toBe(defaultTemplate.content);
  });

  it("keeps role behavior materially separated", () => {
    const catalogue = loadSoulTemplateCatalogue(process.cwd());
    expect(getSoulTemplate(catalogue, "operations-engineer").content).toContain("live software system");
    expect(getSoulTemplate(catalogue, "companion").content).toContain("everyday questions");
    expect(getSoulTemplate(catalogue, "minimal").content).toContain("without adding a strong persona");
  });
});
