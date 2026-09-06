import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkillPaths } from "../src/skills.js";
import {
  getSkillPackStatus,
  hashSkillPackDirectorySha256,
  installSkillFromPack,
  installSkillPack,
  removeSkillPack,
} from "../src/skillPacks.js";

const tempDirs: string[] = [];

function temp(label: string): string {
  const path = join(tmpdir(), `agent-bridge-pack-review-${label}-${process.pid}-${tempDirs.length}`);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

function writeSkill(repo: string, path: string, id: string, marker: string): void {
  const dir = join(repo, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: Review fixture ${id}.\n---\n\n# ${id}\n\n${marker}\n`,
  );
}

function deps() {
  return { requiredLocal: [], optionalLocal: [], externalServices: [], hostedMcps: [], requiredSecrets: [] };
}

function skill(id: string, repo: string, path: string, description = `Curated ${id}.`) {
  return {
    id,
    description,
    content: {
      repository: repo,
      revision: "fixture-revision",
      path,
      sha256: hashSkillPackDirectorySha256(join(repo, path)),
    },
    provenance: {
      origin: "author-created",
      modifiedFromUpstream: false,
      lastReviewed: "2026-09-06",
    },
    supportedHosts: ["codex", "claude", "agy"],
    dependencies: deps(),
    capabilities: { effects: ["local-read"], approval: "Normal runtime authorization remains authoritative." },
    tests: ["tests/review.md"],
  };
}

function pack(id: string, version: string, skills: ReturnType<typeof skill>[], withExternalMetadata = false) {
  return {
    id,
    displayName: id,
    description: `Review fixture ${id}.`,
    version,
    maintainer: "Farstax",
    license: "Apache-2.0",
    categories: ["fixture"],
    capabilityTags: ["business:test"],
    attribution: [],
    compatibility: { apiVersion: 1, minAgentBridgeVersion: "0.1.0", supportedHosts: ["codex", "claude", "agy"] },
    dependencies: withExternalMetadata ? {
      ...deps(),
      externalServices: [{ name: "Campaign API", purpose: "Publish approved campaign changes", url: "https://example.com/api", authorization: "OAuth" }],
      requiredSecrets: [{ name: "CAMPAIGN_TOKEN", purpose: "Authenticate approved campaign changes" }],
    } : deps(),
    capabilities: {
      effects: withExternalMetadata ? ["external-write"] : ["local-read"],
      approval: withExternalMetadata ? "External writes require explicit runtime authorization." : "Local read only.",
    },
    tests: ["tests/pack.md"],
    skills,
  };
}

function catalogue(root: string, packs: ReturnType<typeof pack>[]): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, catalogueId: "review", catalogueVersion: "1.0.0", packs }, null, 2)}\n`);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Skill Pack review invariants", () => {
  it("keeps full pack and Skill metadata inspectable after installation", async () => {
    const home = temp("status-home");
    const root = temp("status-root");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "v1");
    const source = catalogue(root, [pack("marketing", "1.0.0", [skill("shared", repo, "skills/shared")], true)]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: source, agentBridgeVersion: "0.1.0" });

    const status = getSkillPackStatus({ homeDir: home });
    expect(status.packs.marketing.manifest.dependencies.externalServices[0].authorization).toBe("OAuth");
    expect(status.packs.marketing.manifest.dependencies.requiredSecrets[0].name).toBe("CAMPAIGN_TOKEN");
    expect(status.packs.marketing.manifest.capabilities.effects).toEqual(["external-write"]);
    expect(status.skills.shared.description).toBe("Curated shared.");
  });

  it("does not let an explicit install mutate a Skill still owned by an installed pack", async () => {
    const home = temp("explicit-home");
    const root = temp("explicit-root");
    const repo = join(root, "content");
    writeSkill(repo, "v1/shared", "shared", "version one");
    writeSkill(repo, "v2/shared", "shared", "version two");
    const source = catalogue(root, [
      pack("marketing", "1.0.0", [skill("shared", repo, "v1/shared")]),
      pack("marketing", "2.0.0", [skill("shared", repo, "v2/shared")]),
    ]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: source, agentBridgeVersion: "0.1.0", requestedPackVersion: "1.0.0" });

    await expect(installSkillFromPack("marketing", "shared", {
      homeDir: home,
      catalogueSource: source,
      agentBridgeVersion: "0.1.0",
      requestedPackVersion: "2.0.0",
    })).rejects.toThrow(/while referenced by installed packs/i);

    expect(readFileSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared", "SKILL.md"), "utf8")).toContain("version one");
    expect(getSkillPackStatus({ homeDir: home }).packs.marketing.version).toBe("1.0.0");
  });

  it("requires overlapping packs to agree on the complete shared Skill contract", async () => {
    const home = temp("overlap-home");
    const root = temp("overlap-root");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "same content");
    const first = skill("shared", repo, "skills/shared", "First metadata contract.");
    const second = skill("shared", repo, "skills/shared", "Different metadata contract.");
    const source = catalogue(root, [pack("marketing", "1.0.0", [first]), pack("sales", "1.0.0", [second])]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: source, agentBridgeVersion: "0.1.0" });
    await expect(installSkillPack("sales", { homeDir: home, catalogueSource: source, agentBridgeVersion: "0.1.0" }))
      .rejects.toThrow(/inconsistent|cannot change/i);

    expect(getSkillPackStatus({ homeDir: home }).skills.shared.packRefs).toEqual(["marketing"]);
  });

  it("fails closed when pack removal would delete an unmanaged native replacement", async () => {
    const home = temp("remove-home");
    const root = temp("remove-root");
    const repo = join(root, "content");
    writeSkill(repo, "skills/shared", "shared", "managed content");
    const source = catalogue(root, [pack("marketing", "1.0.0", [skill("shared", repo, "skills/shared")])]);

    await installSkillPack("marketing", { homeDir: home, catalogueSource: source, agentBridgeVersion: "0.1.0" });
    const native = join(resolveSkillPaths(home).claudeSkillsDir, "shared");
    rmSync(native, { recursive: true, force: true });
    mkdirSync(native, { recursive: true });
    writeFileSync(join(native, "SKILL.md"), "unmanaged replacement\n");

    expect(() => removeSkillPack("marketing", { homeDir: home })).toThrow(/unmanaged native Skill path/i);
    expect(readFileSync(join(native, "SKILL.md"), "utf8")).toBe("unmanaged replacement\n");
    expect(getSkillPackStatus({ homeDir: home }).packs.marketing).toBeDefined();
    expect(existsSync(join(resolveSkillPaths(home).agentsSkillsDir, "shared"))).toBe(true);
  });
});
