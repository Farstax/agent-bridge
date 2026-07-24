import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

describe("release artifact manifest", () => {
  it("binds the artifact to its commit, tree, lockfile and deterministic file hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "console.log('release');\n");
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), "{\"name\": \"agent-bridge\"}\n");

    const manifest = buildReleaseManifest({
      root,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.commit).toBe("a".repeat(40));
    expect(manifest.tree).toBe("b".repeat(40));
    expect(manifest.package_lock_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      "dist/index.js",
      "package-lock.json",
      "package.json",
    ]);
    expect(manifest.files.every((file: { sha256: string; size: number }) =>
      /^[0-9a-f]{64}$/.test(file.sha256) && file.size > 0
    )).toBe(true);
  });

  it("does not include the manifest itself or files outside the artifact root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "lock\n");
    writeFileSync(join(root, "manifest.json"), "stale\n");

    const manifest = buildReleaseManifest({
      root,
      commit: "c".repeat(40),
      tree: "d".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(["package-lock.json"]);
    expect(manifest.files.some((file: { path: string }) => file.path.includes(".."))).toBe(false);
  });

  it("rejects symlinks that escape the artifact root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "lock\n");
    symlinkSync("/etc/passwd", join(root, "escaped"));

    expect(() => buildReleaseManifest({
      root,
      commit: "e".repeat(40),
      tree: "f".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    })).toThrow(/escaped root/);
  });

  it("uses the exact event head for artifact naming and portable checksum output", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(workflow).toContain("name: agent-bridge-release-${{ github.event.pull_request.head.sha || github.sha }}");
    expect(workflow).toContain('( cd "$(dirname "$archive")" && sha256sum "$(basename "$archive")" )');
  });

  it("packages the source entrypoints and guarded migration scripts required by the service contract", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");

    expect(workflow).toContain("cp -a dist src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json node_modules");
    for (const entrypoint of [
      "src/index.ts",
      "src/index-interactive.ts",
      "src/index-discord-interactive.ts",
      "src/index-health.ts",
      "src/index-worker.ts",
      "scripts/rollout-db.ts",
      "scripts/rollout-db-impl.ts",
    ]) {
      expect(readFileSync(join(process.cwd(), entrypoint), "utf8")).not.toHaveLength(0);
    }
  });

  it("defines the historical two-identity artifact builder as read-only CI", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("target_commit:");
    expect(workflow).toContain("expected_tree:");
    expect(workflow).toContain("builder_commit:");
    expect(workflow).toContain("path: trusted-builder");
    expect(workflow).toContain("path: target-source");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("releaseProvenance.mjs");
    expect(workflow).toContain("archive.members.txt");
    expect(workflow).not.toContain("secrets.");
  });

  it("isolates target execution from trusted proving in separate jobs", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const [, buildTargetJob, proveJob] = workflow.split(/^  (?=build-target:|prove:)/m);

    expect(buildTargetJob).toBeDefined();
    expect(proveJob).toBeDefined();
    // The target-executing job never checks out or references trusted builder tooling.
    expect(buildTargetJob).not.toContain("trusted-builder");
    expect(buildTargetJob).not.toContain("releaseManifest.mjs");
    expect(buildTargetJob).not.toContain("releaseProvenance.mjs");
    // The proving job never checks out target source or runs target-controlled scripts.
    expect(proveJob).not.toContain("path: target-source");
    expect(proveJob).not.toContain("npm ci");
    expect(proveJob).not.toContain("npm test");
    expect(proveJob).not.toContain("npm run build");
    expect(proveJob).not.toContain("arch-lint.sh");
    expect(proveJob).toContain("needs: build-target");
    // Materials cross the job boundary only as an opaque uploaded/downloaded artifact.
    expect(buildTargetJob).toContain("upload-artifact");
    expect(proveJob).toContain("download-artifact");
  });

  it("binds the reviewed builder commit to the workflow revision GitHub actually executed", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("WORKFLOW_SHA: ${{ github.workflow_sha }}");
    expect(workflow).toContain('test "$BUILDER_COMMIT" = "$WORKFLOW_SHA"');
  });

  it("hashes the manifest and provenance tool and derives evidence from archived-not-staged content", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("--provenance-tool trusted-builder/scripts/releaseProvenance.mjs");
    // No --root argument to releaseProvenance.mjs: evidence must not be derived from re-stating
    // the mutable staging directory after the archive has already been created.
    const proveStep = workflow.slice(workflow.indexOf("releaseProvenance.mjs \\"));
    expect(proveStep).not.toContain("--root \"$root\"");
  });

  it("extracts the manifest from the completed archive rather than hashing the staging copy", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    // The manifest fed to releaseProvenance.mjs must be read back out of the archive tar
    // already produced, proving manifestSha256 reflects the archived bytes, not a staging
    // file that could have drifted between manifest generation and tar creation.
    expect(workflow).toContain('tar --extract --gzip --to-stdout --file "$archive" ./manifest.json > "$RUNNER_TEMP/manifest-from-archive.json"');
    expect(workflow).toContain('--manifest "$RUNNER_TEMP/manifest-from-archive.json"');
    expect(workflow).not.toContain('--manifest "$root/manifest.json"');
    // The extraction must happen after the archive exists.
    expect(workflow.indexOf("tar --create --gzip")).toBeLessThan(workflow.indexOf("manifest-from-archive.json"));
  });

  it("re-verifies target tracked source is unmodified after target-controlled scripts run", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const [, buildTargetJob] = workflow.split(/^  (?=build-target:|prove:)/m);

    expect(buildTargetJob).toContain("git diff --quiet HEAD -- src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json");
    expect(buildTargetJob).toContain("git status --porcelain -- src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json");
    // The re-check must run after the build/prune steps (which execute target-controlled
    // scripts) and before packaging, so a script that rewrites tracked source post-verification
    // is caught before those files are shipped under the original commit's identity.
    const pruneIndex = buildTargetJob.indexOf("Retain target production dependencies only");
    const recheckIndex = buildTargetJob.indexOf("git status --porcelain -- src");
    const packageIndex = buildTargetJob.indexOf("Package raw target materials");
    expect(pruneIndex).toBeLessThan(recheckIndex);
    expect(recheckIndex).toBeLessThan(packageIndex);
  });

  it("verifies provenance against bytes extracted from the completed archive, not tar listing text", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    // The archive is extracted into a dedicated verify root after archiveSha256 is already
    // computed, and releaseProvenance.mjs walks real extracted bytes/symlink targets rather
    // than trusting `tar --list --verbose` text (which has repeatedly drifted from tar's
    // actual output format: missing "./" prefixes, and dropping hardlink "h" entries).
    expect(workflow).toContain('tar --extract --gzip --file "$archive" --directory "$verify"');
    expect(workflow).toContain('--verify-root "$verify"');
    const archiveShaIndex = workflow.indexOf('sha256sum "$(basename "$archive")"');
    const verifyExtractIndex = workflow.indexOf('--directory "$verify"');
    expect(archiveShaIndex).toBeLessThan(verifyExtractIndex);
  });

  it("uploads the archive-extracted manifest, not the mutable staging copy", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const uploadStep = workflow.slice(workflow.indexOf("Upload non-production historical artifact"));

    // The delivered manifest.json must be byte-identical to what manifestSha256 was computed
    // from, so a consumer hashing the downloaded manifest actually matches provenance.json.
    expect(uploadStep).toContain("${{ runner.temp }}/manifest-from-archive.json");
    expect(uploadStep).not.toContain("agent-bridge-historical-release/manifest.json");
  });
});
