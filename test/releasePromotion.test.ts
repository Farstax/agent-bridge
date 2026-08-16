import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: string[] = [];
const verifier = fileURLToPath(new URL("../scripts/verify-release-promotion.sh", import.meta.url));

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function buildArtifact(options: { manifestWorkflowRun?: string; corruptChecksum?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-release-promotion-"));
  cleanup.push(root);
  const payload = join(root, "payload");
  const artifactDir = join(root, "artifact");
  mkdirSync(join(payload, "dist"), { recursive: true });
  mkdirSync(artifactDir);

  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const workflowRun = "123456789";
  const manifestWorkflowRun = options.manifestWorkflowRun ?? workflowRun;

  writeFileSync(join(payload, "dist", "index.js"), "export const ready = true;\n");
  writeFileSync(join(payload, "package.json"), '{"name":"release-promotion-fixture","type":"module"}\n');
  writeFileSync(join(payload, "package-lock.json"), '{"name":"release-promotion-fixture","lockfileVersion":3}\n');
  writeJson(join(payload, "qualification-evidence.json"), {
    commit,
    tree,
    workflow_run: workflowRun,
    workflow_head: commit,
    checks: ["test", "typecheck", "architecture-lint", "compile", "manifest"],
  });

  const declaredPaths = [
    "dist/index.js",
    "package.json",
    "package-lock.json",
    "qualification-evidence.json",
  ];
  const files = declaredPaths.map((path) => {
    const absolute = join(payload, path);
    return { path, sha256: sha256(absolute), size: statSync(absolute).size };
  });

  writeJson(join(payload, "manifest.json"), {
    schema_version: 1,
    commit,
    tree,
    build_strategy: "compiled",
    package_lock_sha256: files.find((file) => file.path === "package-lock.json")?.sha256,
    runtime: { node: "v24.15.0", platform: "linux", arch: "x64" },
    files,
    builder: { commit, workflow_run: manifestWorkflowRun, workflow_head: commit },
    database_schema_version: 4,
  });

  const archive = join(artifactDir, `agent-bridge-${commit}.tar.gz`);
  execFileSync("tar", ["--create", "--gzip", "--file", archive, "--directory", payload, "."]);
  const checksum = options.corruptChecksum ? "0".repeat(64) : sha256(archive);
  writeFileSync(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`);

  return { artifactDir, commit, workflowRun };
}

function runVerifier(artifactDir: string, commit: string, workflowRun: string) {
  return spawnSync(
    "bash",
    [verifier, "--artifact-dir", artifactDir, "--commit", commit, "--workflow-run", workflowRun],
    { encoding: "utf8" },
  );
}

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe("GitHub release promotion", () => {
  it("defines a manual promotion workflow without rebuilding the artifact", () => {
    const workflow = readFileSync(
      fileURLToPath(new URL("../.github/workflows/publish-release.yml", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("workflow_run_id:");
    expect(workflow).toContain("commit_sha:");
    expect(workflow).toContain("release_tag:");
    expect(workflow).toMatch(/actions:\s*read/);
    expect(workflow).toMatch(/contents:\s*write/);
    expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toContain("scripts/verify-release-promotion.sh");
    expect(workflow).not.toMatch(/\bnpm\s+(?:ci|test)\b/);
    expect(workflow).not.toMatch(/\bnpm\s+run\s+build\b/);
  });

  it("generates release notes with a changelog via the release notes script", () => {
    const workflow = readFileSync(
      fileURLToPath(new URL("../.github/workflows/publish-release.yml", import.meta.url)),
      "utf8",
    );

    expect(workflow).toContain("scripts/generate-release-notes.sh");
    expect(workflow).toContain("--previous-tag");
    expect(workflow).toMatch(/fetch-depth:\s*0/);
  });

  it("accepts an exact qualified archive and reports its identity", () => {
    const fixture = buildArtifact();
    const result = runVerifier(fixture.artifactDir, fixture.commit, fixture.workflowRun);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      commit: fixture.commit,
      workflow_run: fixture.workflowRun,
      archive: `agent-bridge-${fixture.commit}.tar.gz`,
    });
  });

  it("rejects builder provenance from another workflow run", () => {
    const fixture = buildArtifact({ manifestWorkflowRun: "987654321" });
    const result = runVerifier(fixture.artifactDir, fixture.commit, fixture.workflowRun);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("manifest builder workflow run does not match");
  });

  it("rejects an archive whose checksum does not match", () => {
    const fixture = buildArtifact({ corruptChecksum: true });
    const result = runVerifier(fixture.artifactDir, fixture.commit, fixture.workflowRun);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive checksum does not match");
  });
});
