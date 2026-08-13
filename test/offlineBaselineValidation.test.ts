import { execFileSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { buildReleaseManifest } from "../scripts/releaseManifest.mjs";
import { createLegacyFixture } from "./support/legacyDbFixture.js";

describe("offline baseline validator", () => {
  it("downloads named artifact and fixture bundles instead of assuming runner paths", () => {
    const workflow = readFileSync(".github/workflows/offline-baseline-validation.yml", "utf8");
    const releaseWorkflow = readFileSync(".github/workflows/release-artifact.yml", "utf8");
    expect(workflow).toContain("gh run download");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("artifact_run_id");
    expect(workflow).toContain("db_fixture_run_id");
    expect(workflow).toContain('expected_schema="$(tar --extract');
    expect(workflow).toContain("--artifact-run-id");
    expect(workflow).toContain("gh run view");
    expect(workflow).toContain('test "$run_head" = "${{ inputs.builder_commit }}"');
    expect(workflow).toContain('[[ "$run_name" == "Release Artifact" || "$run_name" == "Historical Release Artifact" ]]');
    expect(releaseWorkflow).toContain('mkdir -p "$root/scripts"');
    expect(releaseWorkflow).toContain('scripts/rollout-db.ts scripts/rollout-db-impl.ts scripts/upgrade.sh');
    expect(workflow).toContain('expected_schema="$(tar --extract');
    expect(workflow).not.toContain('tar --extract --gzip --file "$archive" --directory offline-input/runtime');
    expect(workflow).not.toContain("--runtime-root offline-input/runtime");
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

  it("accepts contained relative artifact symlinks but rejects links escaping the archive root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-symlink-safety-test-"));
    const containedRoot = join(root, "contained");
    mkdirSync(join(containedRoot, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(containedRoot, "node_modules", "tool"), "tool\n");
    symlinkSync("../tool", join(containedRoot, "node_modules", ".bin", "tool"));
    linkSync(join(containedRoot, "node_modules", "tool"), join(containedRoot, "node_modules", "hard-tool"));
    const containedArchive = join(root, "contained.tar.gz");
    execFileSync("tar", ["-czf", containedArchive, "-C", containedRoot, "."]);
    const extracted = join(root, "extracted");
    mkdirSync(extracted);
    execFileSync("python3", ["-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("validator", "scripts/offline-baseline-validate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.safe_extract(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
`, containedArchive, extracted], { encoding: "utf8" });
    expect(readFileSync(join(extracted, "node_modules", ".bin", "tool"), "utf8")).toBe("tool\n");
    expect(readFileSync(join(extracted, "node_modules", "hard-tool"), "utf8")).toBe("tool\n");

    const escapeRoot = join(root, "escape");
    mkdirSync(escapeRoot);
    symlinkSync("../../outside", join(escapeRoot, "escape"));
    const escapeArchive = join(root, "escape.tar.gz");
    execFileSync("tar", ["-czf", escapeArchive, "-C", escapeRoot, "."]);
    const escapeExtracted = join(root, "escape-extracted");
    expect(() => execFileSync("python3", ["-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("validator", "scripts/offline-baseline-validate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.safe_extract(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
`, escapeArchive, escapeExtracted], { encoding: "utf8" })).toThrow(/escapes extraction root/);
    expect(existsSync(join(escapeExtracted, "escape"))).toBe(false);

    const hardlinkArchive = join(root, "hardlink-escape.tar.gz");
    execFileSync("python3", ["-c", `
import tarfile, sys
with tarfile.open(sys.argv[1], "w:gz") as archive:
    member = tarfile.TarInfo("hard-escape")
    member.type = tarfile.LNKTYPE
    member.linkname = "../../outside"
    archive.addfile(member)
`, hardlinkArchive], { encoding: "utf8" });
    const hardlinkExtracted = join(root, "hardlink-extracted");
    expect(() => execFileSync("python3", ["-c", `
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("validator", "scripts/offline-baseline-validate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.safe_extract(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
`, hardlinkArchive, hardlinkExtracted], { encoding: "utf8" })).toThrow(/escapes extraction root/);
    expect(existsSync(join(hardlinkExtracted, "hard-escape"))).toBe(false);
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

  it("migrates a copied schema-3 fixture with the target runtime before validating schema 5", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-schema-migration-offline-test-"));
    const fixture = join(root, "schema3.sqlite");
    createLegacyFixture(fixture);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/rollout-db.ts", "migrate", "--db", fixture, "--evidence", "-"], { encoding: "utf8" });
    const database = new Database(fixture);
    database.exec("DROP TABLE reconciliation_audit; PRAGMA user_version = 3;");
    database.exec(`
      INSERT INTO pending_messages
        (surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, state, claim_run_id, claim_acquisition_id, claimed_at, attachments_json)
      VALUES ('discord', 'chat:claimed', 'claimed prompt', 42, 7, 'private', 99, 'claimed', 'run-claimed', 'acq-claimed', '2026-07-27T00:00:00Z', '["attachment.txt"]');
      INSERT INTO bridge_runs
        (run_id, chat_id, bot, status, started_at, ended_at, session_id, final_text_preview, error)
      VALUES ('run-claimed', '42', 'codex', 'failed', '2026-07-27T00:00:00Z', '2026-07-27T00:01:00Z', 'session-claimed', 'result preview', 'failure detail');
      INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
      VALUES ('event-claimed', 'run-claimed', 1, 'run.failed', '2026-07-27T00:01:00Z', '{"payload":"preserve"}');
      INSERT INTO execution_locks
        (surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at)
      VALUES ('discord', 'chat:claimed', 'service-claimed', 'run-claimed', 'acq-claimed', '2026-07-27T00:00:00Z', '2026-07-27T01:00:00Z');
    `);
    database.close();
    const artifactRoot = join(root, "artifact");
    mkdirSync(artifactRoot, { recursive: true });
    cpSync("package-lock.json", join(artifactRoot, "package-lock.json"));
    writeFileSync(join(artifactRoot, "package.json"), JSON.stringify({ type: "module", dependencies: { tsx: "^4.21.0" } }));
    cpSync("tsconfig.json", join(artifactRoot, "tsconfig.json"));
    cpSync("src", join(artifactRoot, "src"), { recursive: true });
    mkdirSync(join(artifactRoot, "scripts"), { recursive: true });
    cpSync("scripts/rollout-db.ts", join(artifactRoot, "scripts", "rollout-db.ts"));
    cpSync("scripts/rollout-db-impl.ts", join(artifactRoot, "scripts", "rollout-db-impl.ts"));
    cpSync("node_modules", join(artifactRoot, "node_modules"), { recursive: true, dereference: true });
    rmSync(join(artifactRoot, "node_modules", ".bin"), { recursive: true, force: true });
    mkdirSync(join(artifactRoot, "node_modules", ".bin"));
    cpSync("node_modules/tsx/dist/cli.mjs", join(artifactRoot, "node_modules", ".bin", "tsx"));
    writeFileSync(join(artifactRoot, "runtime-marker"), "runtime\n");
    const builderCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const manifest = buildReleaseManifest({
      root: artifactRoot, commit: "a".repeat(40), tree: "b".repeat(40), nodeVersion: "v24.15.0",
      platform: "linux", arch: "x64", builderCommit, builderWorkflowRun: "123",
      builderWorkflowHead: builderCommit, databaseSchemaVersion: 5,
    });
    writeFileSync(join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = join(root, "artifact.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", artifactRoot, "."]);
    const runtimeRoot = join(root, "runtime");
    mkdirSync(runtimeRoot);
    execFileSync("tar", ["-xzf", archive, "-C", runtimeRoot]);
    const output = join(root, "evidence.json");
    const helperHash = execFileSync("sha256sum", ["scripts/rollout-agent-bridge.sh"], { encoding: "utf8" }).split(" ")[0];
    const evidence = JSON.parse(execFileSync("python3", [
      "scripts/offline-baseline-validate.py", "--archive", archive,
      "--target-commit", "a".repeat(40), "--expected-tree", "b".repeat(40),
      "--builder-commit", builderCommit, "--artifact-run-id", "123", "--expected-schema", "5",
      "--rollout-helper-sha256", helperHash, "--rollout-helper", "scripts/rollout-agent-bridge.sh",
      "--runtime-root", runtimeRoot, "--db-root", root, "--output", output,
    ], { encoding: "utf8" }));
    expect(evidence.schema_compatibility).toContain("migrated");
    expect(evidence.databases[0].source_schema_version).toBe(3);
    expect(evidence.databases[0].user_version).toBe(6);
    expect(evidence.preservation.queue_claim_run_lock_preserved).toBe(true);
    expect(evidence.prestart_rollback_simulation.database_hashes_after_restore).toEqual(
      evidence.prestart_rollback_simulation.database_hashes_before,
    );
  }, 30000);

  it("rejects tampering with a protected identity column", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-identity-tamper-test-"));
    const before = join(root, "before.sqlite");
    const after = join(root, "after.sqlite");
    createLegacyFixture(before);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/rollout-db.ts", "migrate", "--db", before, "--evidence", "-"], { encoding: "utf8" });
    const seeded = new Database(before);
    seeded.exec(`
      INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at, final_text_preview, error)
      VALUES ('run-tamper', '42', 'codex', 'failed', '2026-07-27T00:00:00Z', 'preview', 'original');
    `);
    seeded.close();
    cpSync(before, after);
    const database = new Database(after);
    database.prepare("UPDATE bridge_runs SET error = ? WHERE run_id = ?").run("tampered", "run-tamper");
    database.close();
    expect(() => execFileSync("python3", ["-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("validator", "scripts/offline-baseline-validate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.assert_identity_preserved(module.identity_snapshot(sys.argv[1]), module.identity_snapshot(sys.argv[2]))
`, before, after], { encoding: "utf8" })).toThrow(/identity changed/);
  });
});
