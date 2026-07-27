import { createHash } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
// buildReleaseManifest now requires valid package.json content to derive a build strategy
// (compiled requires a non-empty dist/). This fixture exercises the generic staging/hardlink/
// tamper mechanism, not build-strategy semantics, so it just satisfies "compiled" minimally.
const PACKAGE_JSON_CONTENT = `${JSON.stringify({ name: "stage-test", scripts: { build: "true" } })}\n`;

function makeArchive(withHardlink = false, withExecutable = false, packageContent = PACKAGE_JSON_CONTENT): { archive: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-stage-input-"));
  writeFileSync(join(root, "package-lock.json"), "lock\n");
  writeFileSync(join(root, "package.json"), packageContent);
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "placeholder.js"), "// placeholder\n");
  if (withHardlink) {
    linkSync(join(root, "package.json"), join(root, "package-copy.json"));
  }
  if (withExecutable) {
    mkdirSync(join(root, "bin"));
    const executable = join(root, "bin", "runtime-entry");
    writeFileSync(executable, "#!/bin/sh\n");
    chmodSync(executable, 0o755);
  }
  const manifest = buildReleaseManifest({
    root,
    commit: COMMIT,
    tree: TREE,
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
  });
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  chmodSync(join(root, "package.json"), 0o644);
  const archive = join(tmpdir(), `agent-bridge-${COMMIT}-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "."]);
  return { archive, root };
}

function runStage(archive: string, releaseRoot: string, expectedCommit = COMMIT, extraEnv: Record<string, string> = {}): string {
  return execFileSync("python3", [
    "scripts/release-stage.py",
    "--archive", archive,
    "--release-root", releaseRoot,
    "--expected-commit", expectedCommit,
    "--archive-sha256", createHash("sha256").update(readFileSync(archive)).digest("hex"),
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_RELEASE_STAGE_TEST: "1", ...extraEnv },
  });
}

describe("immutable release staging", () => {
  it("stages and validates an exact archive into a commit-addressed immutable directory", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    const output = runStage(archive, releaseRoot);
    const release = join(releaseRoot, COMMIT);

    expect(output).toMatch(new RegExp(`staged ${COMMIT}`));
    expect(readFileSync(join(release, "package.json"), "utf8")).toBe(PACKAGE_JSON_CONTENT);
    expect(statSync(join(release, "package.json")).mode & 0o222).toBe(0);
    expect(statSync(release).mode & 0o222).toBe(0);
    const provenance = JSON.parse(readFileSync(join(releaseRoot, `.${COMMIT}.staging-provenance.json`), "utf8"));
    expect(provenance).toEqual({ commit: COMMIT, archive_sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), schema_version: 1 });
  });

  it("preserves executable mode bits for runtime entries", () => {
    const { archive } = makeArchive(false, true);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    runStage(archive, releaseRoot);

    expect(statSync(join(releaseRoot, COMMIT, "bin", "runtime-entry")).mode & 0o111).toBe(0o111);
  });

  it("stages GNU tar hardlinks without weakening manifest validation", () => {
    const { archive } = makeArchive(true, false);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    expect(runStage(archive, releaseRoot)).toMatch(new RegExp(`staged ${COMMIT}`));
    expect(readFileSync(join(releaseRoot, COMMIT, "package-copy.json"), "utf8")).toBe(PACKAGE_JSON_CONTENT);
  });

  it("is idempotent for an already validated release", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    runStage(archive, releaseRoot);
    expect(runStage(archive, releaseRoot)).toMatch(new RegExp(`already staged ${COMMIT}`));
  });

  it("fails closed on an unexpected commit without creating a release", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));
    expect(() => execFileSync("python3", [
      "scripts/release-stage.py", "--archive", archive,
      "--release-root", releaseRoot, "--expected-commit", "3".repeat(40),
      "--archive-sha256", createHash("sha256").update(readFileSync(archive)).digest("hex"),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_BRIDGE_RELEASE_STAGE_TEST: "1" },
    })).toThrow();

    expect(existsSync(join(releaseRoot, COMMIT))).toBe(false);
  });

  it("rejects an archive whose bytes do not match the approved digest before publication", () => {
    const { archive } = makeArchive();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));
    expect(() => execFileSync("python3", [
      "scripts/release-stage.py", "--archive", archive,
      "--release-root", releaseRoot, "--expected-commit", COMMIT,
      "--archive-sha256", "0".repeat(64),
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AGENT_BRIDGE_RELEASE_STAGE_TEST: "1" } })).toThrow(/archive SHA-256/i);
    expect(existsSync(join(releaseRoot, COMMIT))).toBe(false);
  });

  it("extracts from the hashed descriptor even if the archive pathname is replaced after hashing", () => {
    const original = makeArchive(false, false, PACKAGE_JSON_CONTENT);
    const replacement = makeArchive(false, false, `${JSON.stringify({ name: "replacement", scripts: { build: "true" } })}\n`);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    expect(runStage(original.archive, releaseRoot, COMMIT, {
      AGENT_BRIDGE_RELEASE_STAGE_TEST_REPLACE_ARCHIVE: replacement.archive,
    })).toMatch(new RegExp(`staged ${COMMIT}`));
    expect(readFileSync(join(releaseRoot, COMMIT, "package.json"), "utf8")).toBe(PACKAGE_JSON_CONTENT);
  });

  it("extracts from a private snapshot if the source inode is mutated after hashing", () => {
    const original = makeArchive(false, false, PACKAGE_JSON_CONTENT);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    expect(runStage(original.archive, releaseRoot, COMMIT, {
      AGENT_BRIDGE_RELEASE_STAGE_TEST_MUTATE_ARCHIVE: "1",
    })).toMatch(new RegExp(`staged ${COMMIT}`));
    expect(readFileSync(join(releaseRoot, COMMIT, "package.json"), "utf8")).toBe(PACKAGE_JSON_CONTENT);
  });

  it("rejects a tampered archive before publication", () => {
    const { root } = makeArchive();
    writeFileSync(join(root, "package.json"), "tampered\n");
    const archive = join(tmpdir(), `agent-bridge-tampered-${COMMIT}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, "."]);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-releases-"));

    expect(() => runStage(archive, releaseRoot)).toThrow();
    expect(existsSync(join(releaseRoot, COMMIT))).toBe(false);
  });

  it("rejects a release root symlink instead of staging outside the configured root", () => {
    const { archive } = makeArchive();
    const parent = mkdtempSync(join(tmpdir(), "agent-bridge-release-root-"));
    const target = mkdtempSync(join(tmpdir(), "agent-bridge-release-target-"));
    const releaseRoot = join(parent, "releases");
    symlinkSync(target, releaseRoot);

    expect(() => runStage(archive, releaseRoot)).toThrow();
    expect(existsSync(join(target, COMMIT))).toBe(false);
  });
});
