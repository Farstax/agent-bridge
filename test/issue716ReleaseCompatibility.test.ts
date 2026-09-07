import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";
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

function compiledArtifactRoot(): string {
  const root = tempDir("artifact");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "export const ready = true;\n");
  writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" } }));
  return root;
}

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("issue #716 release compatibility identity", () => {
  it("uses the installed release manifest identity instead of the static package version", async () => {
    const root = tempDir("runtime");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", version: "0.1.0" }));
    writeFileSync(join(root, "manifest.json"), `${JSON.stringify({
      schema_version: 1,
      release: { tag: "release-2026.09.06-2", compatibility_version: "2026.9.6-2" },
    }, null, 2)}\n`);
    const catalogueSource = writeCatalogue(root, "2026.9.6-2");

    await expect(getAvailableSkillPack("marketing", { catalogueSource, repoRoot: root }))
      .resolves.toMatchObject({ id: "marketing", compatibility: { minAgentBridgeVersion: "2026.9.6-2" } });
  });

  it("derives distinct compatibility versions from supported release tags", () => {
    const root = compiledArtifactRoot();
    const base = {
      root,
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    };

    const first = buildReleaseManifest({ ...base, releaseTag: "release-2026.09.06-2" });
    const second = buildReleaseManifest({ ...base, releaseTag: "release-2026.09.06-3" });

    expect(first.release).toEqual({ tag: "release-2026.09.06-2", compatibility_version: "2026.9.6-2" });
    expect(second.release).toEqual({ tag: "release-2026.09.06-3", compatibility_version: "2026.9.6-3" });
    expect(first.release.compatibility_version).not.toBe(second.release.compatibility_version);
  });

  it("rejects release tags that cannot form a canonical compatibility version", () => {
    const root = compiledArtifactRoot();
    expect(() => buildReleaseManifest({
      root,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
      releaseTag: "release-2026.13.01-1",
    })).toThrow(/release tag/i);
  });
});
