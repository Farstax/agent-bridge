import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths, verifySkillGlobal } from "../src/skills.js";
import {
  getSkillCollectionStatus,
  hashSkillCollectionDirectorySha256,
  installManagedSkill,
  installSkillCollection,
  loadSkillCollectionCatalogue,
  removeManagedSkill,
  removeSkillCollection,
} from "../src/skillCollections.js";

const tempDirs: string[] = [];
const upstreamRevision = "0123456789abcdef0123456789abcdef01234567";

function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `agent-bridge-collection-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeSkill(repoRoot: string, relativeDir: string, id: string, body: string): void {
  const dir = join(repoRoot, relativeDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: Test ${id} Skill.\n---\n\n# ${id}\n\n${body}\n`);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function skill(id: string, repoRoot: string, path: string) {
  const notice = join(repoRoot, "NOTICE.txt");
  if (!existsSync(notice)) writeFileSync(notice, "MIT upstream notice\n");
  return {
    id,
    description: `${id} from a curated fixture.`,
    content: { repository: repoRoot, revision: upstreamRevision, path, sha256: hashSkillCollectionDirectorySha256(join(repoRoot, path)) },
    provenance: {
      origin: "adapted-upstream" as const,
      upstreamRepository: "https://github.com/example/upstream",
      upstreamRevision,
      upstreamLicense: "MIT",
      noticePath: "NOTICE.txt",
      noticeSha256: hashFile(notice),
      modifiedFromUpstream: true,
      lastReviewed: "2026-09-14",
    },
  };
}

function writeCatalogue(root: string, skills: ReturnType<typeof skill>[], collections: Array<{ id: string; name: string; description: string; skills: string[] }>): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 2, catalogueId: "test-catalogue", skills, collections }, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lightweight Skill Collections", () => {
  it("keeps canonical Skill contracts separate from Collection curation", async () => {
    const root = makeTempDir("catalogue");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const catalogue = writeCatalogue(root, [skill("research", repo, "skills/research")], [
      { id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] },
      { id: "sales", name: "Sales", description: "Sales helpers", skills: ["research"] },
    ]);

    const loaded = await loadSkillCollectionCatalogue({ catalogueSource: catalogue });
    expect(loaded.collections[0]).toEqual({ id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] });
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0].provenance.upstreamLicense).toBe("MIT");
  });

  it("rejects obsolete Pack runtime/dependency metadata rather than preserving a second capability model", async () => {
    const root = makeTempDir("obsolete");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const entry = skill("research", repo, "skills/research") as any;
    entry.dependencies = { requiredSecrets: [{ name: "TOKEN", purpose: "auth" }] };
    const catalogue = writeCatalogue(root, [entry], [{ id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] }]);

    await expect(loadSkillCollectionCatalogue({ catalogueSource: catalogue })).rejects.toThrow(/unsupported field.*dependencies/i);
  });

  it("installs canonical ordinary Skills and reference-counts overlapping Collections", async () => {
    const home = makeTempDir("home");
    const root = makeTempDir("install");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const catalogue = writeCatalogue(root, [skill("shared", repo, "skills/shared")], [
      { id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["shared"] },
      { id: "sales", name: "Sales", description: "Sales helpers", skills: ["shared"] },
    ]);

    await installSkillCollection("marketing", { homeDir: home, catalogueSource: catalogue });
    await installSkillCollection("sales", { homeDir: home, catalogueSource: catalogue });

    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
    expect(getSkillCollectionStatus({ homeDir: home }).skills.shared.collectionRefs).toEqual(["marketing", "sales"]);
    expect(removeSkillCollection("marketing", { homeDir: home }).retained).toEqual(["shared"]);
    expect(removeSkillCollection("sales", { homeDir: home }).removed).toEqual(["shared"]);
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared"))).toBe(false);
  });

  it("installs a managed catalogue Skill directly without a Collection lifecycle", async () => {
    const home = makeTempDir("direct-home");
    const root = makeTempDir("direct");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const catalogue = writeCatalogue(root, [skill("research", repo, "skills/research")], []);

    await installManagedSkill("research", { homeDir: home, catalogueSource: catalogue });
    expect(verifySkillGlobal("research", { homeDir: home }).ok).toBe(true);
    expect(getSkillCollectionStatus({ homeDir: home }).skills.research.explicit).toBe(true);
    expect(removeManagedSkill("research", { homeDir: home }).removed).toEqual(["research"]);
  });

  it("migrates legacy Pack state idempotently without reinstalling installed Skills", async () => {
    const home = makeTempDir("migration-home");
    const root = makeTempDir("migration");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const catalogue = writeCatalogue(root, [skill("shared", repo, "skills/shared")], [
      { id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["shared"] },
    ]);
    await installSkillCollection("marketing", { homeDir: home, catalogueSource: catalogue });

    const state = getSkillCollectionStatus({ homeDir: home });
    const collectionLock = join(home, ".agents", ".skill-collection-lock.json");
    rmSync(collectionLock, { force: true });
    writeFileSync(join(home, ".agents", ".skill-pack-lock.json"), `${JSON.stringify({
      version: 1,
      packs: {
        marketing: {
          version: "1.0.0",
          manifestSha256: "0".repeat(64),
          catalogueId: "test-catalogue",
          catalogueVersion: "1.0.0",
          catalogueSource: catalogue,
          skills: ["shared"],
          manifest: {},
          installedAt: state.collections.marketing.installedAt,
          updatedAt: state.collections.marketing.updatedAt,
        },
      },
      skills: {
        shared: {
          explicit: false,
          packRefs: ["marketing"],
          description: "legacy duplicate metadata",
          content: state.skills.shared.content,
          provenance: state.skills.shared.provenance,
          supportedHosts: ["codex"],
          dependencies: {},
          capabilities: {},
          tests: [],
          installedAt: state.skills.shared.installedAt,
          updatedAt: state.skills.shared.updatedAt,
          noticeLocalPath: state.skills.shared.noticeLocalPath,
        },
      },
    }, null, 2)}\n`);

    const migrated = getSkillCollectionStatus({ homeDir: home });
    expect(migrated.collections.marketing.skills).toEqual(["shared"]);
    expect(migrated.skills.shared.collectionRefs).toEqual(["marketing"]);
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
    expect(existsSync(join(home, ".agents", ".skill-pack-lock.json"))).toBe(false);
    expect(getSkillCollectionStatus({ homeDir: home })).toEqual(migrated);
  });
});
