import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths, uninstallSkillGlobal, verifySkillGlobal } from "../src/skills.js";
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

  it("reference-counts overlapping pack Skills and removes them only after the last reference", async () => {
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

  it("keeps an explicitly installed pack Skill when its pack is later removed", async () => {
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

  it("fails closed instead of overwriting a replaced native projection", async () => {
    const home = makeTempDir("collision-home");
    const root = makeTempDir("collision");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("shared", repo, "skills/shared")])]);
    const options = { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" };

    await installSkillPack("marketing", options);
    const native = join(resolveSkillPaths(home).claudeSkillsDir, "shared");
    rmSync(native, { recursive: true, force: true });
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "SKILL.md"), "unmanaged replacement\n");

    await expect(updateSkillPack("marketing", options)).rejects.toThrow(/unmanaged native Skill path/i);
    expect(readFileSync(join(native, "SKILL.md"), "utf8")).toBe("unmanaged replacement\n");
  });

  it("reconciles pack state when an interrupted operation leaves the core Skill missing", async () => {
    const home = makeTempDir("retry-home");
    const root = makeTempDir("retry");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "Shared capability.");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("shared", repo, "skills/shared")])]);
    const options = { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0" };

    await installSkillPack("marketing", options);
    uninstallSkillGlobal("shared", { homeDir: home, expectedOwnership: "user" });
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(false);

    await updateSkillPack("marketing", options);
    expect(verifySkillGlobal("shared", { homeDir: home }).ok).toBe(true);
    expect(getSkillPackStatus({ homeDir: home }).skills.shared.packRefs).toEqual(["marketing"]);
  });

  it("supports exact pack versions and deterministic update to another catalogue version", async () => {
    const home = makeTempDir("update-home");
    const root = makeTempDir("update");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "Version one.");
    writeSkill(repo, "v2/shared", "shared", "Version two.");
    const v1 = skillManifest("shared", repo, "v1/shared");
    const v2 = skillManifest("shared", repo, "v2/shared");
    const catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [v1]), pack("marketing", "2.0.0", [v2])], "2.0.0");

    await installSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0", requestedPackVersion: "1.0.0" });
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("Version one.");

    // Simulate an interruption after the desired v2 pack state was persisted but
    // before the ordinary shared Skill content was replaced. Retry must compare
    // the canonical content hash, not only the pack lock metadata.
    const packLock = join(home, ".agents", ".skill-pack-lock.json");
    const interrupted = JSON.parse(readFileSync(packLock, "utf8"));
    interrupted.skills.shared.content = v2.content;
    writeFileSync(packLock, `${JSON.stringify(interrupted, null, 2)}\n`);

    await updateSkillPack("marketing", { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0", requestedPackVersion: "2.0.0" });
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("Version two.");
    expect(getSkillPackStatus({ homeDir: home }).packs.marketing.version).toBe("2.0.0");
  });

  it("rejects changed manifest content under an already-installed pack version", async () => {
    const home = makeTempDir("immutable-home");
    const root = makeTempDir("immutable");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "Version one.");
    let catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("shared", repo, "v1/shared")])]);
    const base = { homeDir: home, catalogueSource: catalogue, agentBridgeVersion: "0.1.0", requestedPackVersion: "1.0.0" };
    await installSkillPack("marketing", base);

    writeSkill(repo, "v1-rewritten/shared", "shared", "Rewritten without a version bump.");
    catalogue = writeCatalogue(root, [pack("marketing", "1.0.0", [skillManifest("shared", repo, "v1-rewritten/shared")])], "1.0.1");
    await expect(updateSkillPack("marketing", { ...base, catalogueSource: catalogue })).rejects.toThrow(/changed manifest content/i);
    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("Version one.");
  });

  it("fails closed on incompatible, malformed, secret-bearing, unpinned or checksum-invalid metadata", async () => {
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
    unpinned.skills[0].content.repository = "https://github.com/example-org/example-skills";
    unpinned.skills[0].content.revision = "main";
    catalogue = writeCatalogue(root, [unpinned]);
    await expect(installSkillPack("marketing", { homeDir: makeTempDir("revision-home"), catalogueSource: catalogue, agentBridgeVersion: "0.1.0", fetchImpl: async () => new Response("{}") })).rejects.toThrow(/exact 40-character commit SHA/i);
  });

  it("rejects a remote catalogue when no allowlisted repository is configured", async () => {
    const original = process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO;
    delete process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO;
    try {
      await expect(listAvailableSkillPacks({
        catalogueSource: "https://example.com/catalogue.json",
        fetchImpl: async () => new Response("{}"),
      })).rejects.toThrow(/AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO/i);
    } finally {
      if (original === undefined) delete process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO;
      else process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO = original;
    }
  });

  it("restricts remote catalogue discovery to the configured allowlisted repository", async () => {
    const original = process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO;
    process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO = "example-org/example-skills";
    try {
      await expect(listAvailableSkillPacks({
        catalogueSource: "https://raw.githubusercontent.com/other-org/other-skills/main/catalogue.json",
        fetchImpl: async () => new Response("{}"),
      })).rejects.toThrow(/restricted to the configured example-org\/example-skills repository/i);
    } finally {
      if (original === undefined) delete process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO;
      else process.env.AGENT_BRIDGE_SKILL_PACK_ALLOWED_REPO = original;
    }
  });
});
