import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";

describe("offline baseline validator", () => {
  it("downloads named artifact and fixture bundles instead of assuming runner paths", () => {
    const workflow = readFileSync(".github/workflows/offline-baseline-validation.yml", "utf8");
    expect(workflow).toContain("gh run download");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("artifact_run_id");
    expect(workflow).toContain("db_fixture_run_id");
    expect(workflow).toContain('expected_schema="$(tar --extract');
    expect(workflow).toContain("--artifact-run-id");
    expect(workflow).toContain("gh run view");
    expect(workflow).toContain('test "$run_head" = "${{ inputs.builder_commit }}"');
    expect(workflow).toContain('test "$run_name" = "Historical Release Artifact"');
    expect(workflow).toContain('expected_schema="$(tar --extract');
    expect(workflow).not.toContain("--builder-root");
    expect(workflow).not.toContain("Repository-relative path to a downloaded");
  });

  it("uses atomic pointer replacement and names copied-fixture validation accurately", () => {
    const validator = readFileSync("scripts/offline-baseline-validate.py", "utf8");
    expect(validator).toContain("os.replace(replacement, current)");
    expect(validator).toContain("os.replace(restoration, current)");
    expect(validator).not.toContain("current.unlink()");
    expect(validator).toContain('"schema_compatibility"');
    expect(validator).not.toContain('"startup_compatibility"');
  });

  it("rejects unmanifested archive members and never needs production paths", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-offline-test-"));
    const archive = join(root, "artifact.tar.gz");
    const fixture = join(root, "fixtures");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "copy.sqlite"), "not-a-database");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      commit: "a".repeat(40), tree: "b".repeat(40), files: [],
      builder: {
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        workflow_run: "123",
        workflow_head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      },
      database_schema_version: 4,
    }));
    writeFileSync(join(root, "unexpected.txt"), "unexpected");
    execFileSync("tar", ["-czf", archive, "-C", root, "manifest.json", "unexpected.txt"]);
    expect(() => execFileSync("python3", [
      "scripts/offline-baseline-validate.py", "--archive", archive,
      "--target-commit", "a".repeat(40), "--expected-tree", "b".repeat(40),
      "--artifact-run-id", "123", "--expected-schema", "4",
      "--builder-commit", execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      "--rollout-helper-sha256", execFileSync("sha256sum", ["scripts/rollout-agent-bridge.sh"], { encoding: "utf8" }).split(" ")[0],
      "--rollout-helper", "scripts/rollout-agent-bridge.sh",
      "--db-root", fixture, "--output", join(root, "evidence.json"),
    ], { encoding: "utf8" })).toThrow(/manifest\/archive mismatch/);
  });

  it("validates a genuine schema-3 fixture and rejects a false schema-4 declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-schema3-offline-test-"));
    const artifactRoot = join(root, "artifact");
    mkdirSync(join(artifactRoot, "dist"), { recursive: true });
    writeFileSync(join(artifactRoot, "dist", "index.js"), "console.log('schema3');\n");
    writeFileSync(join(artifactRoot, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    writeFileSync(join(artifactRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
    const builderCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const manifest = buildReleaseManifest({
      root: artifactRoot,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      nodeVersion: "v24.15.0",
      platform: "linux",
      arch: "x64",
      builderCommit,
      builderWorkflowRun: "123",
      builderWorkflowHead: builderCommit,
      databaseSchemaVersion: 3,
    });
    writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = join(root, "artifact.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", artifactRoot, "."]);

    const fixture = join(root, "schema3.sqlite");
    const database = new Database(fixture);
    database.pragma("user_version = 3");
    for (const table of ["bridge_runs", "bridge_events", "execution_locks", "pending_messages"]) {
      database.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    }
    database.close();

    const args = [
      "scripts/offline-baseline-validate.py", "--archive", archive,
      "--target-commit", "a".repeat(40), "--expected-tree", "b".repeat(40),
      "--builder-commit", builderCommit, "--artifact-run-id", "123", "--expected-schema", "3",
      "--rollout-helper-sha256", execFileSync("sha256sum", ["scripts/rollout-agent-bridge.sh"], { encoding: "utf8" }).split(" ")[0],
      "--rollout-helper", "scripts/rollout-agent-bridge.sh", "--db-root", root,
      "--output", join(root, "evidence.json"),
    ];
    const evidence = JSON.parse(execFileSync("python3", args, { encoding: "utf8" }));
    expect(evidence.databases[0].user_version).toBe(3);
    expect(() => execFileSync("python3", args.map((value) => value === "3" ? "4" : value), { encoding: "utf8" }))
      .toThrow(/manifest database schema identity mismatch/);
  });
});
