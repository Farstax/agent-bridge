import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths, verifySkillGlobal } from "../src/skills.js";
import {
  getSkillPackStatus,
  hashSkillPackDirectorySha256,
  installSkillFromPack,
  installSkillPack,
  listAvailableSkillPacks,
  loadSkillPackCatalogue,
  removeExplicitSkillPackSkill,
  removeSkillPack,
  updateSkillPack,
} from "../src/skillPacks.js";
import { uninstallUserSkillGlobal } from "../src/userSkills.js";

const tempDirs: string[] = [];
const upstreamRevision = "0123456789abcdef0123456789abcdef01234567";

function makeTempDir(label: string): string {
  const dir = join(tmpdir(), `agent-bridge-pack-${label}-${process.pid}-${tempDirs.length}`);
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

function emptyDependencies() {
  return { requiredLocal: [], optionalLocal: [], externalServices: [], hostedMcps: [], requiredSecrets: [] };
}

function skillManifest(id: string, repoRoot: string, path: string, external = false) {
  const notice = join(repoRoot, "NOTICE.txt");
  if (!existsSync(notice)) writeFileSync(notice, "MIT upstream notice\n");
  return {
    id,
    description: `${id} from a curated fixture.`,
    content: { repository: repoRoot, revision: upstreamRevision, path, sha256: hashSkillPackDirectorySha256(join(repoRoot, path)) },
    provenance: {
      origin: "adapted-upstream",
      upstreamRepository: "https://github.com/example/upstream",
      upstreamRevision,
      upstreamLicense: "MIT",
      noticePath: "NOTICE.txt",
      noticeSha256: hashFile(notice),
      modifiedFromUpstream: true,
      lastReviewed: "2026-09-06",
    },
    supportedHosts: ["codex", "claude", "agy"],
    dependencies: external ? {
      ...emptyDependencies(),
      hostedMcps: [{ name: "analytics", purpose: "Read campaign data", url: "https://example.com/mcp", authorization: "OAuth" }],
      requiredSecrets: [{ name: "ANALYTICS_TOKEN", purpose: "Authenticate analytics reads" }],
    } : emptyDependencies(),
    capabilities: { effects: external ? ["external-read"] : ["local-read"], approval: "Normal tool authorization remains authoritative." },
    tests: [`tests/${id}.md`],
  };
}

function pack(id: string, version: string, skills: ReturnType<typeof skillManifest>[]) {
  return {
    id,
    displayName: id.replace(/-/g, " "),
    description: `Fixture pack ${id}.`,
    version,
    maintainer: "Farstax",
    license: "Apache-2.0",
    categories: ["fixture"],
    capabilityTags: ["business:test"],
    attribution: ["https://github.com/example/upstream"],
    compatibility: { apiVersion: 1, minAgentBridgeVersion: "0.1.0", supportedHosts: ["codex", "claude", "agy"] },
    dependencies: emptyDependencies(),
    capabilities: { effects: ["local-read"], approval: "Install does not authorize external actions." },
    tests: ["tests/pack.md"],
    skills,
  };
}

function writeCatalogue(root: string, packs: ReturnType<typeof pack>[], version = "1.0.0"): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, catalogueId: "farstax-test", catalogueVersion: version, packs }, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("curated Skill Packs", () => {
  it("loads versioned metadata including provenance, dependencies, effects and business tags", async () => {
    const root = makeTempDir("catalogue");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("research", repo, "skills/research", true)])]);

    const loaded = await loadSkillPackCatalogue({ catalogueSource: catalogue });
    expect(loaded.catalogueVersion).toBe("1.0.0");
    expect(loaded.packs[0].capabilityTags).toEqual(["business:test"]);
    expect(loaded.packs[0].attribution).toEqual(["https://github.com/example/upstream"]);
    expect(loaded.packs[0].skills[0].provenance.upstreamLicense).toBe("MIT");
    expect(loaded.packs[0].skills[0].dependencies.requiredSecrets[0].name).toBe("ANALYTICS_TOKEN");
    expect(loaded.packs[0].skills[0].capabilities.effects).toEqual(["external-read"]);
  });

  it("installs ordinary Skills through existing shared provider projections and keeps inspectable state", async () => {
    const home = makeTempDir("home");
    const root = makeTempDir("install");
    const repo = join(root, "content");
    writeSkill(repo, "skills/research", "research", "Research only.");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("research", repo, "skills/research", true)])]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" });

    const paths = resolveSkillPaths(home);
    expect(readlinkSync(join(paths.codexSkillsDir, "research"))).toBe("../../.agents/skills/research");
    expect(readlinkSync(join(paths.claudeSkillsDir, "research"))).toBe("../../.agents/skills/research");
    expect(readlinkSync(join(paths.geminiSkillsDir, "research"))).toBe("../../../.agents/skills/research");
    expect(verifySkillGlobal("research", { homeDir: home }).ok).toBe(true);
    const status = getSkillPackStatus({ homeDir: home });
    expect(status.packs.marketing.version).toBe("1.0.0");
    expect(status.skills.research.packRefs).toEqual(["marketing"]);
    expect(status.skills.research.provenance.upstreamRepository).toBe("https://github.com/example/upstream");
    expect(status.skills.research.dependencies.hostedMcps[0].authorization).toBe("OAuth");
  });

  it("reference-counts overlapping Skills and removes only the final reference", async () => {
    const home = makeTempDir("overlap-home");
    const root = makeTempDir("overlap");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const shared = skillManifest("shared", repo, "skills/shared");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [shared]), pack("sales", "1.0.0", [shared])]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" });
    await installSkillPack("sales", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" });
    expect(getSkillPackStatus({ homeDir: home }).skills.shared.packRefs).toEqual(["marketing", "sales"]);
    expect(removeSkillPack("marketing", { homeDir: home }).retained).toEqual(["shared"]);
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared"))).toBe(true);
    expect(removeSkillPack("sales", { homeDir: home }).removed).toEqual(["shared"]);
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared"))).toBe(false);
  });

  it("keeps an explicitly installed pack Skill when its pack is removed", async () => {
    const home = makeTempDir("explicit-home");
    const root = makeTempDir("explicit");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("shared", repo, "skills/shared")])]);
    const options = { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" };

    await installSkillFromPack("marketing", "shared", options);
    await installSkillPack("marketing", options);
    expect(removeSkillPack("marketing", { homeDir: home }).retained).toEqual(["shared"]);
    expect(getSkillPackStatus({ homeDir: home }).skills.shared.explicit).toBe(true);
    expect(() => uninstallUserSkillGlobal("shared", { homeDir: home, repoRoot: root })).toThrow(/pack-managed/i);
    expect(removeExplicitSkillPackSkill("shared", { homeDir: home }).removed).toEqual(["shared"]);
  });

  it("supports exact pack versions and deterministic updates", async () => {
    const home = makeTempDir("update-home");
    const root = makeTempDir("update");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "Version one.");
    writeSkill(repo, "v2/shared", "shared", "Version two.");
    const catalogue = writeCatalogue(root, [
      pack("marketing", "1.0.0", [skillManifest("shared", repo, "v1/shared")]),
      pack("marketing", "2.0.0", [skillManifest("shared", repo, "v2/shared")]),
    ], "2.0.0");

    await installSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0", requestedPackVersion: "1.0.0" });
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("Version one.");
    await updateSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0", requestedPackVersion: "2.0.0" });
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("Version two.");
    expect(getSkillPackStatus({ homeDir: home }).packs.marketing.version).toBe("2.0.0");
  });

  it("fails closed on compatibility, secret values, checksum failures and unpinned GitHub content", async () => {
    const root = makeTempDir("invalid");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const valid = pack("marketing", "1.0.0", [skillManifest("shared", repo, "skills/shared")]);

    const incompatible = structuredClone(valid);
    incompatible.compatibility.minAgentBridgeVersion = "9.0.0";
    let catalogue = writeCatalogue(root, [incompatible]);
    await expect(installSkillPack("marketing", { homeDir: makeTempDir("incompatible-home"), catalogueSource: catalogue, agentBridgeVersion: "0.1.0" })).rejects.toThrow(/requires Agent Bridge/);

    const secretBearing = structuredClone(valid) as any;
    secretBearing.skills[0].dependencies.requiredSecrets = [{ name: "TOKEN", purpose: "auth", value: "do-not-accept" }];
    catalogue = writeCatalogue(root, [secretBearing]);
    await expect(loadSkillPackCatalogue({ catalogueSource: catalogue })).rejects.toThrow(/unsupported field.*value/i);

    const badChecksum = structuredClone(valid);
    badChecksum.skills[0].content.sha256 = "0".repeat(64);
    catalogue = writeCatalogue(root, [badChecksum]);
    await expect(installSkillPack("marketing", { homeDir: makeTempDir("checksum-home"), catalogueSource: catalogue, agentBridgeVersion: "0.1.0" })).rejects.toThrow(/checksum mismatch/i);

    const unpinned = structuredClone(valid);
    unpinned.skills[0].content.repository = "https://github.com/Farstax/agent-bridge-skills";
    unpinned.skills[0].content.revision = "main";
    catalogue = writeCatalogue(root, [unpinned]);
    await expect(installSkillPack("marketing", { homeDir: makeTempDir("revision-home"), catalogueSource: catalogue, agentBridgeVersion: "0.1.0", fetchImpl: async () => new Response("{}") })).rejects.toThrow(/exact 40-character commit SHA/i);
  });

  it("restricts remote discovery to the curated Farstax upstream", async () => {
    await expect(listAvailableSkillPacks({ catalogueSource: "https://example.com/catalogue.json", fetchImpl: async () => new Response("{}") }))
      .rejects.toThrow(/restricted to the curated Farstax\/agent-bridge-skills repository/i);
  });
});
