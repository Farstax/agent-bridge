import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";
import { releaseCompatibilityVersion } from "../scripts/releaseVersion.mjs";
import { stampReleaseCompatibilityVersion } from "../scripts/stampReleaseVersion.mjs";
import { getAvailableSkillPack } from "../src/skillPacks.js";

const cleanup: string[] = [];
const sha256 = "a".repeat(64);
const revision = "b".repeat(40);

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-bridge-716-${label}-`));
  cleanup.push(root);
  return root;
}

function emptyDependencies() {
  return { requiredLocal: [], optionalLocal: [], externalServices: [], hostedMcps: [], requiredSecrets: [] };
}

function writeCatalogue(root: string, minAgentBridgeVersion: string): string {
  const path = join(root, "catalogue.json");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    catalogueId: "issue-716",
    catalogueVersion: "1.0.0",
    packs: [{
      id: "marketing",
      displayName: "Marketing",
      description: "Issue 716 compatibility fixture.",
      version: "1.0.0",
      maintainer: "Farstax",
      license: "Apache-2.0",
      categories: ["fixture"],
      capabilityTags: ["business:test"],
      attribution: ["https://github.com/Farstax/agent-bridge-skills"],
      compatibility: { apiVersion: 1, minAgentBridgeVersion, supportedHosts: ["codex"] },
      dependencies: emptyDependencies(),
      capabilities: { effects: ["local-read"], approval: "Normal tool authorization remains authoritative." },
      tests: ["tests/fixture.md"],
      skills: [{
        id: "fixture-skill",
        description: "Fixture Skill.",
        content: { repository: root, revision, path: "skills/fixture-skill", sha256 },
        provenance: {
          origin: "author-created",
          modifiedFromUpstream: false,
          lastReviewed: "2026-09-07",
        },
        supportedHosts: ["codex"],
        dependencies: emptyDependencies(),
        capabilities: { effects: ["local-read"], approval: "Normal tool authorization remains authoritative." },
        tests: ["tests/fixture-skill.md"],
      }],
    }],
  }, null, 2)}\n`);
  return path;
}

function runtimeRoot(label: string, version = "0.1.0"): string {
  const root = tempDir(label);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "agent-bridge", version }, null, 2)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({ name: "agent-bridge", version, lockfileVersion: 3, packages: { "": { name: "agent-bridge", version } } }, null, 2)}\n`);
  return root;
}

function compiledArtifactRoot(): string {
  const root = runtimeRoot("artifact");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "export const ready = true;\n");
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  packageJson.scripts = { build: "tsc" };
  writeFileSync(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  return root;
}

async function expectCompatible(root: string, minimum: string, options: { agentBridgeVersion?: string } = {}) {
  const catalogueSource = writeCatalogue(root, minimum);
  return expect(getAvailableSkillPack("marketing", { catalogueSource, repoRoot: root, ...options }))
    .resolves.toMatchObject({ id: "marketing", compatibility: { minAgentBridgeVersion: minimum } });
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("issue #716 release compatibility identity", () => {
  it("stamps the published artifact identity that bridgeVersion reads by default", async () => {
    const root = runtimeRoot("runtime");
    expect(stampReleaseCompatibilityVersion(root, "release-2026.09.07-2")).toBe("2026.9.7-2");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("2026.9.7-2");
    expect(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[""].version).toBe("2026.9.7-2");

    await expectCompatible(root, "2026.9.7-2");
  });

  it("orders supported release tags monotonically and does not collapse releases", () => {
    expect(releaseCompatibilityVersion("release-2026.09.06-2")).toBe("2026.9.6-2");
    expect(releaseCompatibilityVersion("release-2026.09.06-3")).toBe("2026.9.6-3");
    expect(releaseCompatibilityVersion("release-2026.09.07-1")).toBe("2026.9.7-1");
  });

  it("rejects legacy unstamped and malformed runtime versions, while exact and newer stamped releases pass", async () => {
    const legacyRoot = runtimeRoot("legacy", "0.1.0");
    await expect(getAvailableSkillPack("marketing", {
      catalogueSource: writeCatalogue(legacyRoot, "2026.9.7-2"),
      repoRoot: legacyRoot,
    })).rejects.toThrow(/requires Agent Bridge >= 2026\.9\.7-2; current 0\.1\.0/);

    const exactRoot = runtimeRoot("exact");
    stampReleaseCompatibilityVersion(exactRoot, "release-2026.09.07-2");
    await expectCompatible(exactRoot, "2026.9.7-2");

    const newerRoot = runtimeRoot("newer");
    stampReleaseCompatibilityVersion(newerRoot, "release-2026.09.08-1");
    await expectCompatible(newerRoot, "2026.9.7-2");

    const malformedRoot = runtimeRoot("malformed", "release-2026.09.07-2");
    await expect(getAvailableSkillPack("marketing", {
      catalogueSource: writeCatalogue(malformedRoot, "2026.9.7-2"),
      repoRoot: malformedRoot,
    })).rejects.toThrow(/Invalid semantic version/);
  });

  it("keeps explicit version injection as an override for tests and development", async () => {
    const root = runtimeRoot("override", "0.1.0");
    await expectCompatible(root, "2026.9.7-2", { agentBridgeVersion: "2026.9.7-2" });
  });

  it("embeds the same stamped identity into the release manifest", () => {
    const root = compiledArtifactRoot();
    const releaseTag = "release-2026.09.07-2";
    stampReleaseCompatibilityVersion(root, releaseTag);
    const manifest = buildReleaseManifest({
      root,
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
      releaseTag,
    });

    expect(manifest.release).toEqual({ tag: releaseTag, compatibility_version: "2026.9.7-2" });
  });

  it("fails closed on malformed release tags and unstamped artifact metadata", () => {
    const invalidRoot = compiledArtifactRoot();
    expect(() => stampReleaseCompatibilityVersion(invalidRoot, "release-2026.13.01-1")).toThrow(/release tag/i);

    const unstampedRoot = compiledArtifactRoot();
    expect(() => buildReleaseManifest({
      root: unstampedRoot,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
      releaseTag: "release-2026.09.07-2",
    })).toThrow(/package version 0\.1\.0 does not match compatibility version 2026\.9\.7-2/);
  });
});
