import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths } from "../src/skills.js";
import {
  getSkillCollectionStatus,
  hashSkillCollectionDirectorySha256,
  installManagedSkill,
  installSkillCollection,
  removeSkillCollection,
  updateSkillCollection,
} from "../src/skillCollections.js";

const tempDirs: string[] = [];

function temp(label: string): string {
  const path = join(tmpdir(), `agent-bridge-collection-review-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function writeSkill(repo: string, path: string, id: string, marker: string): void {
  const dir = join(repo, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: Review fixture ${id}.\n---\n\n# ${id}\n\n${marker}\n`);
}

function skill(id: string, repo: string, path: string) {
  return {
    id,
    description: `Curated ${id}.`,
    content: { repository: repo, revision: "fixture-revision", path, sha256: hashSkillCollectionDirectorySha256(join(repo, path)) },
    provenance: { origin: "author-created" as const, modifiedFromUpstream: false, lastReviewed: "2026-09-14" },
  };
}

function catalogue(root: string, skills: ReturnType<typeof skill>[], collections: Array<{ id: string; name: string; description: string; skills: string[] }>): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 2, catalogueId: "review", skills, collections }, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Skill Collection safety invariants", () => {
  it("does not let a direct install mutate a Skill still referenced by a Collection", async () => {
    const home = temp("direct-home");
    const root = temp("direct-root");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "version one");
    writeSkill(repo, "v2/shared", "shared", "version two");
    let source = catalogue(root, [skill("shared", repo, "v1/shared")], [{ id: "marketing", name: "Marketing", description: "Marketing", skills: ["shared"] }]);
    await installSkillCollection("marketing", { homeDir: home, catalogueSource: source });

    source = catalogue(root, [skill("shared", repo, "v2/shared")], [{ id: "marketing", name: "Marketing", description: "Marketing", skills: ["shared"] }]);
    await expect(installManagedSkill("shared", { homeDir: home, catalogueSource: source })).rejects.toThrow(/referenced by Collections/i);
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("version one");
  });

  it("does not let one Collection change a shared Skill still referenced by another", async () => {
    const home = temp("shared-home");
    const root = temp("shared-root");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "version one");
    writeSkill(repo, "v2/shared", "shared", "version two");
    let source = catalogue(root, [skill("shared", repo, "v1/shared")], [
      { id: "marketing", name: "Marketing", description: "Marketing", skills: ["shared"] },
      { id: "sales", name: "Sales", description: "Sales", skills: ["shared"] },
    ]);
    await installSkillCollection("marketing", { homeDir: home, catalogueSource: source });
    await installSkillCollection("sales", { homeDir: home, catalogueSource: source });

    source = catalogue(root, [skill("shared", repo, "v2/shared")], [
      { id: "marketing", name: "Marketing", description: "Marketing", skills: ["shared"] },
      { id: "sales", name: "Sales", description: "Sales", skills: ["shared"] },
    ]);
    await expect(updateSkillCollection("marketing", { homeDir: home, catalogueSource: source })).rejects.toThrow(/still referenced by Collections: sales/i);
  });

  it("fails closed when Collection removal encounters an unmanaged native replacement", async () => {
    const home = temp("remove-home");
    const root = temp("remove-root");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "managed content");
    const source = catalogue(root, [skill("shared", repo, "skills/shared")], [{ id: "marketing", name: "Marketing", description: "Marketing", skills: ["shared"] }]);
    await installSkillCollection("marketing", { homeDir: home, catalogueSource: source });

    const native = join(resolveSkillPaths(home).claudeSkillsDir, "shared");
    rmSync(native, { recursive: true, force: true });
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "SKILL.md"), "unmanaged replacement\n");

    expect(() => removeSkillCollection("marketing", { homeDir: home })).toThrow(/unmanaged native Skill path/i);
    expect(readFileSync(join(native, "SKILL.md"), "utf8")).toBe("unmanaged replacement\n");
    expect(getSkillCollectionStatus({ homeDir: home }).collections.marketing).toBeDefined();
  });

  it("does not let a remote curated catalogue select local filesystem Skill content", async () => {
    const home = temp("remote-home");
    const localRepo = temp("remote-content");
    writeSkill(localRepo, "skills/shared", "shared", "local content");
    const remoteCatalogue = {
      schemaVersion: 2,
      catalogueId: "remote-review",
      skills: [skill("shared", localRepo, "skills/shared")],
      collections: [{ id: "marketing", name: "Marketing", description: "Remote fixture", skills: ["shared"] }],
    };

    const original = process.env.AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO;
    process.env.AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO = "example-org/example-skills";
    try {
      await expect(installSkillCollection("marketing", {
        homeDir: home,
        catalogueSource: "https://raw.githubusercontent.com/example-org/example-skills/main/catalogue.json",
        fetchImpl: async () => new Response(JSON.stringify(remoteCatalogue), { status: 200 }),
      })).rejects.toThrow(/local Skill content repository requires a local catalogue/i);
    } finally {
      if (original === undefined) delete process.env.AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO;
      else process.env.AGENT_BRIDGE_SKILL_COLLECTION_ALLOWED_REPO = original;
    }
  });
});
