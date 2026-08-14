import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

const REQUIRED_ENTRYPOINTS = [
  "src/index.ts",
  "src/index-interactive.ts",
  "src/index-discord-interactive.ts",
  "src/index-health.ts",
];

function baseArgs(overrides = {}) {
  return {
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    nodeVersion: "v24.15.0",
    platform: "linux",
    arch: "x64",
    ...overrides,
  };
}

// A packaged root satisfying the compiled build strategy: package.json has a build script,
// and the compiled dist/ output is present.
function compiledRoot(root: string) {
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.js"), "console.log('release');\n");
  writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" } }));
  return root;
}

// A packaged root satisfying the source-tsx build strategy: package.json has no build script
// but declares tsx as a production dependency, the tsx runtime CLI is present under
// node_modules, and every canonical src/index*.ts entrypoint exists. No dist/.
function sourceTsxRoot(root: string) {
  writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", resolveJsonModule: true } }));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "agent-bridge",
      scripts: { start: "tsx src/index.ts", test: "vitest run" },
      dependencies: { "better-sqlite3": "^12.9.0", dotenv: "^17.2.3", tsx: "^4.21.0" },
    }),
  );
  mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
  writeFileSync(join(root, "node_modules", "tsx", "dist", "cli.mjs"), "#!/usr/bin/env node\n");
  mkdirSync(join(root, "src"), { recursive: true });
  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    writeFileSync(join(root, entrypoint), `// ${entrypoint}\n`);
  }
  return root;
}

describe("release artifact manifest", () => {
  it("binds the artifact to its commit, tree, lockfile and deterministic file hashes (compiled strategy)", () => {
    const root = compiledRoot(mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-")));

    const manifest = buildReleaseManifest({ root, ...baseArgs() });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.commit).toBe("a".repeat(40));
    expect(manifest.tree).toBe("b".repeat(40));
    expect(manifest.build_strategy).toBe("compiled");
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

  it("binds the artifact to its commit, tree, lockfile and deterministic file hashes (source-tsx strategy)", () => {
    const root = sourceTsxRoot(mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-")));

    const manifest = buildReleaseManifest({ root, ...baseArgs() });

    expect(manifest.build_strategy).toBe("source-tsx");
    expect(manifest.files.map((file: { path: string }) => file.path)).toContain("tsconfig.json");
    expect(manifest.files.map((file: { path: string }) => file.path)).toContain("node_modules/tsx/dist/cli.mjs");
    for (const entrypoint of REQUIRED_ENTRYPOINTS) {
      expect(manifest.files.map((file: { path: string }) => file.path)).toContain(entrypoint);
    }
    expect(manifest.files.some((file: { path: string }) => file.path.startsWith("dist/"))).toBe(false);
  });

  it("characterizes the issue #183 historical baseline (39580135024f2cca329e498f60b18e599ca145fd) as source-tsx", () => {
    // package.json scripts/dependencies observed directly at that commit: no "build" script,
    // tsx as a production dependency, systemd launching src/index-interactive.ts and
    // source entrypoints via node_modules/tsx/dist/cli.mjs.
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
      },
    }));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "agent-bridge",
        scripts: {
          start: "tsx src/index.ts",
          test: "vitest run",
          doctor: "tsx src/doctorCli.ts",
          "test:watch": "vitest",
          typecheck: "tsc --noEmit",
          "typecheck:unused": "tsc --noEmit -p tsconfig.unused.json",
          "cleanup:check": "knip",
          skills: "tsx scripts/skill-manager.ts",
          "scan-token-savings": "tsx scripts/scan-token-savings.ts",
          "smoke:advisor-fallback": "tsx scripts/smoke-advisor-fallback.ts",
        },
        dependencies: { "better-sqlite3": "^12.9.0", dotenv: "^17.2.3", tsx: "^4.21.0" },
      }),
    );
    mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true });
    writeFileSync(join(root, "node_modules", "tsx", "dist", "cli.mjs"), "#!/usr/bin/env node\n");
    mkdirSync(join(root, "src"), { recursive: true });
    for (const entrypoint of REQUIRED_ENTRYPOINTS) {
      writeFileSync(join(root, entrypoint), `// ${entrypoint}\n`);
    }

    const manifest = buildReleaseManifest({
      root,
      commit: "39580135024f2cca329e498f60b18e599ca145fd",
      tree: "6ec3849330d218f6b0a28aadfa295b5dda8d1992",
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
    });

    expect(manifest.build_strategy).toBe("source-tsx");
    expect(manifest.commit).toBe("39580135024f2cca329e498f60b18e599ca145fd");
  });

  it("rejects a compiled strategy with an empty or missing dist directory", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" } }));

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/compiled artifact requires a regular file beneath dist/);
  });

  it("rejects a compiled strategy satisfied only by a dist symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: { build: "tsc" } }));
    mkdirSync(join(root, "dist-real"));
    writeFileSync(join(root, "dist-real", "index.js"), "console.log('release');\n");
    symlinkSync("dist-real", join(root, "dist"));

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/compiled artifact requires a regular file beneath dist/);
  });

  it("rejects a source-tsx artifact containing an unexpected dist directory", () => {
    const root = sourceTsxRoot(mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-")));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "console.log('unexpected');\n");

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/source-tsx artifact must not contain a dist directory/);
  });

  it("rejects a source-tsx artifact missing tsx as a production dependency", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", scripts: {} }));

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/source-tsx artifact requires tsx as a production dependency/);
  });

  it("rejects a source-tsx artifact missing the tsx runtime CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-"));
    writeFileSync(join(root, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-bridge", dependencies: { tsx: "^4.21.0" } }));
    mkdirSync(join(root, "src"), { recursive: true });
    for (const entrypoint of REQUIRED_ENTRYPOINTS) {
      writeFileSync(join(root, entrypoint), `// ${entrypoint}\n`);
    }

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/source-tsx artifact is missing the tsx runtime CLI: node_modules\/tsx\/dist\/cli\.mjs/);
  });

  it("rejects source-tsx runtime files replaced by symlinks", () => {
    const root = sourceTsxRoot(mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-")));
    const target = join(root, "tsx-cli-target.mjs");
    writeFileSync(target, "#!/usr/bin/env node\n");
    rmSync(join(root, "node_modules", "tsx", "dist", "cli.mjs"));
    symlinkSync(target, join(root, "node_modules", "tsx", "dist", "cli.mjs"));

    expect(() => buildReleaseManifest({ root, ...baseArgs() })).toThrow(/source-tsx artifact requires a regular tsx runtime CLI/);
  });

  it("does not include the manifest itself or files outside the artifact root", () => {
    const root = compiledRoot(mkdtempSync(join(tmpdir(), "agent-bridge-release-manifest-")));
    writeFileSync(join(root, "manifest.json"), "stale\n");

    const manifest = buildReleaseManifest({ root, commit: "c".repeat(40), tree: "d".repeat(40), nodeVersion: "v24.15.0", platform: "linux", arch: "x64" });

    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual([
      "dist/index.js",
      "package-lock.json",
      "package.json",
    ]);
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

    expect(workflow).toContain("cp -a dist src package.json package-lock.json node_modules");
    expect(workflow).toContain('mkdir -p "$root/scripts"');
    expect(workflow).toContain('scripts/rollout-db.ts scripts/rollout-db-impl.ts scripts/upgrade.sh');
    expect(workflow).toContain('scripts/upgrade.sh');
    expect(workflow).toContain('scripts/skill-manager.ts');
    expect(workflow).toContain('cp -a skills/. "$root/skills/"');
    expect(workflow).not.toContain('cp -a skills "$root/skills/"');
    expect(workflow).toContain('tsconfig.json');
    expect(workflow).toContain('SOUL.md');
    for (const entrypoint of [...REQUIRED_ENTRYPOINTS, "scripts/rollout-db.ts", "scripts/rollout-db-impl.ts"]) {
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

  it("packages and verifies tsconfig.json for the historical source-tsx strategy", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("package-lock.json tsconfig.json node_modules");
    expect(workflow).toContain("package-lock.json tsconfig.json)");
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

  it("requires artifact manifests to carry builder workflow and schema identities", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/release-artifact.yml"), "utf8");
    expect(workflow).toContain("--builder-workflow-run \"$GITHUB_RUN_ID\"");
    expect(workflow).toContain("--builder-workflow-head");
    expect(workflow).toContain("--database-schema-version");
  });

  it("binds historical artifact provenance to the builder ref rather than the target ref", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    expect(workflow).toContain("Derive target schema contract");
    expect(workflow).toContain('RUN_HEAD: ${{ github.sha }}');
    expect(workflow).toContain('test "$RUN_HEAD" = "$BUILDER_COMMIT"');
    expect(workflow).toContain('--builder-workflow-run "$GITHUB_RUN_ID"');
    expect(workflow).toContain('--builder-workflow-head "$BUILDER_COMMIT"');
    expect(workflow).toContain('--database-schema-version "$target_schema"');
  });

  it("hashes the manifest and provenance tool and derives evidence from archived-not-staged content", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain("--provenance-tool trusted-builder/scripts/releaseProvenance.mjs");
    const proveStep = workflow.slice(workflow.indexOf("releaseProvenance.mjs \\"));
    expect(proveStep).not.toContain("--root \"$root\"");
  });

  it("extracts the manifest from the completed archive rather than hashing the staging copy", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain('tar --extract --gzip --to-stdout --file "$archive" ./manifest.json > "$RUNNER_TEMP/manifest-from-archive.json"');
    expect(workflow).toContain('--manifest "$RUNNER_TEMP/manifest-from-archive.json"');
    expect(workflow).not.toContain('--manifest "$root/manifest.json"');
    expect(workflow.indexOf("tar --create --gzip")).toBeLessThan(workflow.indexOf("manifest-from-archive.json"));
  });

  it("re-verifies target tracked source is unmodified after target-controlled scripts run", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const [, buildTargetJob] = workflow.split(/^  (?=build-target:|prove:)/m);

    expect(buildTargetJob).toContain("git diff --quiet HEAD -- src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json");
    expect(buildTargetJob).toContain("git status --porcelain -- src scripts/rollout-db.ts scripts/rollout-db-impl.ts package.json package-lock.json");
    const pruneIndex = buildTargetJob.indexOf("Retain target production dependencies only");
    const recheckIndex = buildTargetJob.indexOf("git status --porcelain -- src");
    const packageIndex = buildTargetJob.indexOf("Package raw target materials");
    expect(pruneIndex).toBeLessThan(recheckIndex);
    expect(recheckIndex).toBeLessThan(packageIndex);
  });

  it("verifies provenance against bytes extracted from the completed archive, not tar listing text", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");

    expect(workflow).toContain('tar --extract --gzip --file "$archive" --directory "$verify"');
    expect(workflow).toContain('--verify-root "$verify"');
    const archiveShaIndex = workflow.indexOf('sha256sum "$(basename "$archive")"');
    const verifyExtractIndex = workflow.indexOf('--directory "$verify"');
    expect(archiveShaIndex).toBeLessThan(verifyExtractIndex);
  });

  it("uploads the archive-extracted manifest, not the mutable staging copy", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const uploadStep = workflow.slice(workflow.indexOf("Upload non-production historical artifact"));

    expect(uploadStep).toContain("${{ runner.temp }}/manifest-from-archive.json");
    expect(uploadStep).not.toContain("agent-bridge-historical-release/manifest.json");
  });

  it("only compiles the target when a build script exists, and packages dist only when it exists", () => {
    const workflow = readFileSync(join(process.cwd(), ".github/workflows/historical-release-artifact.yml"), "utf8");
    const [, buildTargetJob] = workflow.split(/^  (?=build-target:|prove:)/m);

    // A historical commit predating the build script (e.g. 39580135024f2cca329e498f60b18e599ca145fd,
    // which runs src directly via tsx) must not hit `npm error Missing script: "build"`.
    expect(buildTargetJob).toContain("(require('./package.json').scripts||{}).build");
    expect(buildTargetJob).toContain("npm run build");
    expect(buildTargetJob).toMatch(/if \[ -d (target-source\/)?dist \]/);
  });
});
