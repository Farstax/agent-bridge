import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOUL_TEMPLATE_SCHEMA_VERSION = 1 as const;

const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_HEADINGS = ["Identity", "Values", "Communication Style", "Workflow", "Tool Usage"] as const;

export interface SoulTemplateManifestEntry {
  id: string;
  label: string;
  description: string;
  useCases: string[];
  file: string;
}

export interface SoulTemplateManifest {
  schemaVersion: typeof SOUL_TEMPLATE_SCHEMA_VERSION;
  defaultTemplateId: string;
  templates: SoulTemplateManifestEntry[];
}

export interface SoulTemplate extends SoulTemplateManifestEntry {
  content: string;
}

export interface SoulTemplateCatalogue {
  schemaVersion: typeof SOUL_TEMPLATE_SCHEMA_VERSION;
  defaultTemplateId: string;
  templates: SoulTemplate[];
}

export function defaultSoulTemplateRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadSoulTemplateCatalogue(rootDir = defaultSoulTemplateRoot()): SoulTemplateCatalogue {
  const templateDir = join(rootDir, "soul-templates");
  const manifestPath = join(templateDir, "manifest.json");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const manifest = validateManifest(parsed);
  const templates = manifest.templates.map((entry) => ({
    ...entry,
    content: readTemplate(templateDir, entry),
  }));
  return { schemaVersion: manifest.schemaVersion, defaultTemplateId: manifest.defaultTemplateId, templates };
}

export function getSoulTemplate(catalogue: SoulTemplateCatalogue, templateId: string): SoulTemplate {
  const template = catalogue.templates.find((entry) => entry.id === templateId);
  if (!template) throw new Error(`Unknown soul template: ${templateId}`);
  return template;
}

function validateManifest(value: unknown): SoulTemplateManifest {
  if (!isRecord(value)) throw new Error("Soul template manifest must be an object");
  if (value.schemaVersion !== SOUL_TEMPLATE_SCHEMA_VERSION) throw new Error("Unsupported soul template manifest schema");
  if (typeof value.defaultTemplateId !== "string" || !TEMPLATE_ID.test(value.defaultTemplateId)) {
    throw new Error("Soul template manifest has an invalid defaultTemplateId");
  }
  if (!Array.isArray(value.templates) || value.templates.length === 0) {
    throw new Error("Soul template manifest must contain templates");
  }

  const ids = new Set<string>();
  const templates = value.templates.map((entry, index) => validateEntry(entry, index, ids));
  if (!ids.has(value.defaultTemplateId)) throw new Error("Default soul template is not present in the catalogue");
  return { schemaVersion: SOUL_TEMPLATE_SCHEMA_VERSION, defaultTemplateId: value.defaultTemplateId, templates };
}

function validateEntry(value: unknown, index: number, ids: Set<string>): SoulTemplateManifestEntry {
  if (!isRecord(value)) throw new Error(`Soul template ${index} must be an object`);
  const id = requiredString(value.id, `templates[${index}].id`);
  if (!TEMPLATE_ID.test(id)) throw new Error(`Soul template has an invalid id: ${id}`);
  if (ids.has(id)) throw new Error(`Duplicate soul template id: ${id}`);
  ids.add(id);

  const file = requiredString(value.file, `templates[${index}].file`);
  if (!/^[a-z0-9-]+\.md$/.test(file)) throw new Error(`Soul template has an unsafe file path: ${file}`);
  const useCases = Array.isArray(value.useCases)
    ? value.useCases.map((item, useCaseIndex) => requiredString(item, `templates[${index}].useCases[${useCaseIndex}]`))
    : [];
  if (useCases.length === 0) throw new Error(`Soul template ${id} must declare at least one use case`);

  return {
    id,
    label: requiredString(value.label, `templates[${index}].label`),
    description: requiredString(value.description, `templates[${index}].description`),
    useCases,
    file,
  };
}

function readTemplate(templateDir: string, entry: SoulTemplateManifestEntry): string {
  const path = resolve(templateDir, entry.file);
  const rel = relative(templateDir, path);
  if (rel.startsWith("..") || rel === "") throw new Error(`Soul template escapes catalogue directory: ${entry.file}`);
  const content = readFileSync(path, "utf8").trim();
  if (!content) throw new Error(`Soul template is empty: ${entry.id}`);
  for (const heading of REQUIRED_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m").test(content)) {
      throw new Error(`Soul template ${entry.id} is missing required heading: ${heading}`);
    }
  }
  return `${content}\n`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty text`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
