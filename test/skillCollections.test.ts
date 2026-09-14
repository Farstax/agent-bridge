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

function temp(label: string): string {
  const dir = join(tmpdir(), `agent-bridge-collection-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeSkill(repo: string, path: string, id: string, body: string): void {
  const dir = join(repo, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: Test ${id} Skill.\n---\n\n# ${id}\n\n${body}\n`);
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function skill(id: string, repo: string, path: string) {
  const notice = join(repo, "NOTICE.txt");
  if (!existsSync(notice)) writeFileSync(notice, "MIT upstream notice\n");
  return {
    id,
    description: `${id} from a curated fixture.`,
    content: { repository: repo, revision: upstreamRevision, path, sha256: hashSkillCollectionDirectorySha256(join(repo, path)) },
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

function catalogue(root: string, skills: ReturnType<typeof skill>[], collections: Array<{ id: string; name: string; description: string; skills: string[] }>): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 2, catalogueId: "test-catalogue", skills, collections }, null, 2)}\n`);
  return path;
}

async function seedLegacyMigration(tamperNotice = false) {
  const home = temp(tamperNotice ? "migration-tamper-home" : "migration-home");
  const root = temp(tamperNotice ? "migration-tamper" : "migration");
  const repo = join(root, "content");
  writeSkill(repo, "skills/shared", "shared", "Shared capability.");
  const source = catalogue(root, [skill("shared", repo, "skills/shared")], [{ id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["shared"] }]);
  await installSkillCollection("marketing", { homeDir: home, catalogueSource: source });
  const current = getSkillCollectionStatus({ homeDir: home });

  rmSync(join(home, ".agents", ".skill-collection-lock.json"), { force: true });
  rmSync(join(home, ".agents", "skill-collections"), { recursive: true, force: true });
  const legacyNotice = join(home, ".agents", "skill-packs", "notices", "shared", "NOTICE.txt");
  mkdirSync(join(home, ".agents", "skill-packs", "notices", "shared"), { recursive: true });
  writeFileSync(legacyNotice, tamperNotice ? "tampered notice\n" : "MIT upstream notice\n");
  writeFileSync(join(home, ".agents", ".skill-pack-lock.json"), `${JSON.stringify({
    version: 1,
    packs: { marketing: { catalogueId: "test-catalogue", catalogueSource: source, skills: ["shared"], installedAt: current.collections.marketing.installedAt, updatedAt: current.collections.marketing.updatedAt } },
    skills: { shared: { explicit: false, packRefs: ["marketing"], content: current.skills.shared.content, provenance: current.skills.shared.provenance, installedAt: current.skills.shared.installedAt, updatedAt: current.skills.shared.updatedAt, noticeLocalPath: ".agents/skill-packs/notices/shared/NOTICE.txt" } },
  }, null, 2)}\n`);
  return { home };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lightweight Skill Collections", () => {
  it("keeps canonical Skill contracts separate from Collection curation and rejects Pack metadata", async () => {
    const root = temp("catalogue");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const definition = skill("research", repo, "skills/research");
    const source = catalogue(root, [definition], [
      { id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] },
      { id: "sales", name: "Sales", description: "Sales helpers", skills: ["research"] },
    ]);

    const loaded = await loadSkillCollectionCatalogue({ catalogueSource: source });
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.collections[0]).toEqual({ id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] });

    const obsolete = structuredClone(definition) as any;
    obsolete.dependencies = { requiredSecrets: [{ name: "TOKEN", purpose: "auth" }] };
    const invalid = catalogue(root, [obsolete], [{ id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["research"] }]);
    await expect(loadSkillCollectionCatalogue({ catalogueSource: invalid })).rejects.toThrow(/unsupported field.*dependencies/i);
  });

  it("installs ordinary Skills and reference-counts overlapping Collections", async () => {
    const home = temp("home");
    const root = temp("install");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const source = catalogue(root, [skill("shared", repo, "skills/shared")], [
      { id: "marketing", name: "Marketing", description: "Marketing helpers", skills: ["shared"] },
      { id: "sales", name: "Sales", description: "Sales helpers", skills: ["shared"] },
    ]);

    await installSkillCollection("marketing", { homeDir: home, catalogueSource: source });
    await installSkillCollection("sales", { homeDir: home, catalogueSource: source });
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
    expect(getSkillCollectionStatus({ homeDir: home }).skills.shared.collectionRefs).toEqual(["marketing", "sales"]);
    expect(removeSkillCollection("marketing", { homeDir: home }).retained).toEqual(["shared"]);
    expect(removeSkillCollection("sales", { homeDir: home }).removed).toEqual(["shared"]);
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared"))).toBe(false);
  });

  it("installs a managed Skill directly without a Collection lifecycle", async () => {
    const home = temp("direct-home");
    const root = temp("direct");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const source = catalogue(root, [skill("research", repo, "skills/research")], []);

    await installManagedSkill("research", { homeDir: home, catalogueSource: source });
    expect(verifySkillGlobal("research", { homeDir: home }).ok).toBe(true);
    expect(getSkillCollectionStatus({ homeDir: home }).skills.research.explicit).toBe(true);
    expect(removeManagedSkill("research", { homeDir: home }).removed).toEqual(["research"]);
  });

  it("migrates legacy Pack state and required notices idempotently without reinstalling installed Skills", async () => {
    const { home } = await seedLegacyMigration();
    const migrated = getSkillCollectionStatus({ homeDir: home });
    expect(migrated.collections.marketing.skills).toEqual(["shared"]);
    expect(migrated.skills.shared.collectionRefs).toEqual(["marketing"]);
    expect(migrated.skills.shared.noticeLocalPath).toBe(".agents/skill-collections/notices/shared/NOTICE.txt");
    expect(readFileSync(join(home, migrated.skills.shared.noticeLocalPath!), "utf8")).toBe("MIT upstream notice\n");
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
    expect(existsSync(join(home, ".agents", ".skill-pack-lock.json"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skill-packs", "notices"))).toBe(false);
    expect(getSkillCollectionStatus({ homeDir: home })).toEqual(migrated);
  });

  it("fails closed instead of migrating a tampered legacy provenance notice", async () => {
    const { home } = await seedLegacyMigration(true);
    expect(() => getSkillCollectionStatus({ homeDir: home })).toThrow(/provenance notice checksum mismatch/i);
    expect(existsSync(join(home, ".agents", ".skill-pack-lock.json"))).toBe(true);
    expect(existsSync(join(home, ".agents", ".skill-collection-lock.json"))).toBe(false);
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
  });
});
