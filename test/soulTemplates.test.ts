import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSoulContext } from "../src/soul.js";
import { loadSoulTemplateCatalogue } from "../src/soulTemplates.js";

const cleanupDirs: string[] = [];

function catalogueFixture(manifest: unknown, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "soul-catalogue-"));
  cleanupDirs.push(root);
  mkdirSync(join(root, "soul-templates"));
  writeFileSync(join(root, "soul-templates", "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "soul-templates", name), content);
  }
  return root;
}

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

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

  it("renders every required template section through the soul runtime", () => {
    const catalogue = loadSoulTemplateCatalogue(process.cwd());
    for (const template of catalogue.templates) {
      const root = mkdtempSync(join(tmpdir(), "soul-render-"));
      cleanupDirs.push(root);
      const path = join(root, "SOUL.md");
      writeFileSync(path, template.content);
      const rendered = loadSoulContext({ mode: "summary", path, maxChars: 100_000 });
      expect(rendered, template.id).not.toBeNull();
      for (const heading of ["Identity", "Values", "Communication Style", "Workflow", "Tool Usage"]) {
        expect(rendered, `${template.id}: ${heading}`).toContain(`## ${heading}`);
      }
    }
  });

  it("rejects manifests with an unsupported schema version", () => {
    const root = catalogueFixture({ schemaVersion: 2, defaultTemplateId: "a", templates: [] });
    expect(() => loadSoulTemplateCatalogue(root)).toThrow("Unsupported soul template manifest schema");
  });

  it("rejects a default template that is not in the catalogue", () => {
    const root = catalogueFixture({
      schemaVersion: 1,
      defaultTemplateId: "missing",
      templates: [{ id: "a", label: "A", description: "d", useCases: ["u"], file: "a.md" }],
    }, { "a.md": "content" });
    expect(() => loadSoulTemplateCatalogue(root)).toThrow("Default soul template is not present in the catalogue");
  });

  it("rejects unsafe template file paths before reading them", () => {
    const root = catalogueFixture({
      schemaVersion: 1,
      defaultTemplateId: "a",
      templates: [{ id: "a", label: "A", description: "d", useCases: ["u"], file: "../escape.md" }],
    });
    expect(() => loadSoulTemplateCatalogue(root)).toThrow("Soul template has an unsafe file path: ../escape.md");
  });

  it("rejects duplicate template ids and empty use-case metadata", () => {
    const duplicate = catalogueFixture({
      schemaVersion: 1,
      defaultTemplateId: "a",
      templates: [
        { id: "a", label: "A", description: "d", useCases: ["u"], file: "a.md" },
        { id: "a", label: "B", description: "e", useCases: ["u"], file: "b.md" },
      ],
    });
    expect(() => loadSoulTemplateCatalogue(duplicate)).toThrow("Duplicate soul template id: a");

    const missingUseCases = catalogueFixture({
      schemaVersion: 1,
      defaultTemplateId: "a",
      templates: [{ id: "a", label: "A", description: "d", useCases: [], file: "a.md" }],
    });
    expect(() => loadSoulTemplateCatalogue(missingUseCases)).toThrow("Soul template a must declare at least one use case");
  });

  it("packages the template catalogue and manifest into the immutable release", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");
    expect(workflow).toContain('cp -a soul-templates "$root/"');
  });
});
