import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";
import { releaseCompatibilityVersion } from "../scripts/releaseVersion.mjs";
import { stampReleaseCompatibilityVersion } from "../scripts/stampReleaseVersion.mjs";

const cleanup: string[] = [];

function tempDir(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `agent-bridge-716-${label}-`));
  cleanup.push(root);
  return root;
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

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("issue #716 release compatibility identity", () => {
  it("stamps the published artifact identity that runtime release tooling reads", () => {
    const root = runtimeRoot("runtime");
    expect(stampReleaseCompatibilityVersion(root, "release-2026.09.07-2")).toBe("2026.9.7-2");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("2026.9.7-2");
    expect(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages[""].version).toBe("2026.9.7-2");
  });

  it("orders supported release tags monotonically and does not collapse releases", () => {
    expect(releaseCompatibilityVersion("release-2026.09.06-2")).toBe("2026.9.6-2");
    expect(releaseCompatibilityVersion("release-2026.09.06-3")).toBe("2026.9.6-3");
    expect(releaseCompatibilityVersion("release-2026.09.07-1")).toBe("2026.9.7-1");
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
