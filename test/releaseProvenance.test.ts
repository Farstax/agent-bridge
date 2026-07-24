import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";
import { buildReleaseProvenance } from "../scripts/releaseProvenance.mjs";

// Builds root/archive/members/manifest/verify-root exactly the way the workflow does: real
// `tar` invocations with the workflow's exact flags (create, list, extract), and the manifest
// extracted back out of the finished archive rather than read from the mutable staging copy.
// Hand-typed member lines previously drifted from real GNU tar output — missing the "./"
// prefix, and later dropping hardlink ("h") entries entirely — and let real bugs through
// review undetected. Every fixture here is produced by the real toolchain end to end.
function buildRealisticFixture(root: string) {
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "#!/usr/bin/env node\nconsole.log('release');\n");
  execFileSync("chmod", ["755", join(root, "dist", "index.js")]);
  writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync("../tsx/dist/cli.mjs", join(root, "node_modules", ".bin", "tsx"));
  mkdirSync(join(root, "node_modules", ".dedup"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg-a"), { recursive: true });
  writeFileSync(join(root, "node_modules", ".dedup", "lib.js"), "module.exports = 1;\n");
  linkSync(join(root, "node_modules", ".dedup", "lib.js"), join(root, "node_modules", "pkg-a", "lib.js"));

  const manifest = buildReleaseManifest({
    root,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
  });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const archive = `${root}.tar.gz`;
  execFileSync("tar", [
    "--create", "--gzip", "--file", archive,
    "--directory", root, "--sort=name", "--owner=0", "--group=0", "--numeric-owner", ".",
  ]);
  const archiveMembers = `${archive}.members.txt`;
  writeFileSync(archiveMembers, execFileSync("tar", ["--list", "--verbose", "--numeric-owner", "--file", archive]));
  const extractedManifest = `${archive}.manifest.json`;
  writeFileSync(extractedManifest, execFileSync("tar", ["--extract", "--gzip", "--to-stdout", "--file", archive, "./manifest.json"]));
  const verifyRoot = `${archive}.verify`;
  mkdirSync(verifyRoot);
  execFileSync("tar", ["--extract", "--gzip", "--file", archive, "--directory", verifyRoot]);

  return { root, manifest, manifestPath: extractedManifest, archive, archiveMembers, verifyRoot };
}

function baseFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
  const built = buildRealisticFixture(root);
  const provenanceTool = join(root, "releaseProvenance.mjs");
  writeFileSync(provenanceTool, "// trusted tool contents\n");

  return {
    targetCommit: "a".repeat(40),
    targetTree: "b".repeat(40),
    builderCommit: "c".repeat(40),
    workflowBlob: "d".repeat(40),
    workflowSha256: "e".repeat(64),
    manifestToolSha256: "f".repeat(64),
    manifest: built.manifestPath,
    archive: built.archive,
    archiveMembers: built.archiveMembers,
    verifyRoot: built.verifyRoot,
    provenanceTool,
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
}

describe("historical release provenance", () => {
  it("records identities, hashes, modes, and executable entries verified against extracted archive bytes", () => {
    const fixture = baseFixture();

    const provenance = buildReleaseProvenance(fixture);

    expect(provenance.targetCommit).toBe(fixture.targetCommit);
    expect(provenance.builderCommit).toBe(fixture.builderCommit);
    expect(provenance.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.archiveMembersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.provenanceToolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.packageLockSha256).toMatch(/^[0-9a-f]{64}$/);

    for (const { path } of provenance.modeInventory) {
      expect(path.startsWith("./")).toBe(false);
    }

    expect(provenance.executableEntries).toEqual([{ path: "dist/index.js", mode: "755", type: "file" }]);
    expect(provenance.modeInventory).toContainEqual(
      expect.objectContaining({ path: "package-lock.json", type: "file" }),
    );
    // A valid internal symlink (npm .bin link) must be accounted for, not silently dropped.
    expect(provenance.modeInventory).toContainEqual(
      expect.objectContaining({ path: "node_modules/.bin/tsx", type: "symlink" }),
    );
    // GNU tar hardlinks (npm dedup) resolve to real files on extraction and must be included.
    expect(provenance.modeInventory).toContainEqual(
      expect.objectContaining({ path: "node_modules/pkg-a/lib.js", type: "file" }),
    );
  });

  it("rejects a non-SHA identity", () => {
    const fixture = baseFixture({ builderCommit: "not-a-sha" });
    expect(() => buildReleaseProvenance(fixture)).toThrow(/builderCommit must be a full lowercase Git SHA/);
  });

  it("fails closed when an archived file's content does not match the manifest hash", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
    const built = buildRealisticFixture(root);
    // The archive claims the original hash, but the extracted bytes on disk were swapped —
    // e.g. an archive built from tampered materials under an unchanged filename.
    writeFileSync(join(built.verifyRoot, "dist", "index.js"), "tampered\n");

    const fixture = baseFixture({
      manifest: built.manifestPath,
      archive: built.archive,
      archiveMembers: built.archiveMembers,
      verifyRoot: built.verifyRoot,
    });

    expect(() => buildReleaseProvenance(fixture)).toThrow(/content hash mismatch: dist\/index\.js/);
  });

  it("fails closed when a symlink target does not match the manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
    const built = buildRealisticFixture(root);
    execFileSync("rm", [join(built.verifyRoot, "node_modules", ".bin", "tsx")]);
    symlinkSync("/etc/passwd", join(built.verifyRoot, "node_modules", ".bin", "tsx"));

    const fixture = baseFixture({
      manifest: built.manifestPath,
      archive: built.archive,
      archiveMembers: built.archiveMembers,
      verifyRoot: built.verifyRoot,
    });

    expect(() => buildReleaseProvenance(fixture)).toThrow(/symlink target mismatch: node_modules\/\.bin\/tsx/);
  });

  it("fails closed when the archive contains a file the manifest does not account for", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
    const built = buildRealisticFixture(root);
    writeFileSync(join(built.verifyRoot, "dist", "unexpected.js"), "surprise\n");

    const fixture = baseFixture({
      manifest: built.manifestPath,
      archive: built.archive,
      archiveMembers: built.archiveMembers,
      verifyRoot: built.verifyRoot,
    });

    expect(() => buildReleaseProvenance(fixture)).toThrow(/archive member not present in manifest: dist\/unexpected\.js/);
  });

  it("fails closed when the manifest lists a file missing from the archive", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provenance-"));
    const built = buildRealisticFixture(root);
    const tamperedManifest = JSON.parse(JSON.stringify(built.manifest));
    tamperedManifest.files.push({ path: "dist/missing.js", sha256: "3".repeat(64), size: 9 });
    const tamperedManifestPath = `${built.archive}.tampered-manifest.json`;
    writeFileSync(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);

    const fixture = baseFixture({
      manifest: tamperedManifestPath,
      archive: built.archive,
      archiveMembers: built.archiveMembers,
      verifyRoot: built.verifyRoot,
    });

    expect(() => buildReleaseProvenance(fixture)).toThrow(/manifest file not present in archive: dist\/missing\.js/);
  });
});
