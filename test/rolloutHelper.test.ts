import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import {
  acquireRealSystemdLock,
  actions,
  cleanupRoots,
  createFixture,
  createLegacyDb,
  executable,
  type Fixture,
  helperPath,
  metadata,
  migrationScript,
  nodeModules,
  restoreArguments,
  restoreHelperPath,
  rewriteConfig,
  roots,
  runRestore,
  runRollout,
  sentinelClearPath,
  sha256,
  uniqueUnitName,
  sourceDir,
  units,
  useMinimalInventory,
  waitForAction,
  writeFakeCommands,
} from "./support/rolloutFixture";

afterEach(cleanupRoots);

function prepareImmutableRelease(fixture: Fixture, activeCommit = fixture.expectedCommit): { currentPointer: string; releaseDir: string } {
  const releaseRoot = join(fixture.root, "releases");
  const releaseDir = join(releaseRoot, fixture.expectedCommit);
  mkdirSync(releaseRoot, { recursive: true, mode: 0o755 });
  for (const commit of new Set([fixture.previousCommit, fixture.expectedCommit])) {
    const directory = join(releaseRoot, commit);
    execFileSync("cp", ["-a", `${fixture.project}/.`, directory]);
    const cleanupManifestPaths = [
      "scripts/reap-tmp-artifacts.sh",
      "systemd/agent-bridge-tmp-cleanup.service",
      "systemd/agent-bridge-tmp-cleanup.timer",
    ];
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      schema_version: 1,
      commit,
      files: cleanupManifestPaths.map((path) => ({ path, sha256: sha256(join(directory, path)) })),
    }));
    execFileSync("find", [directory, "-type", "f", "-exec", "chmod", "a-w", "{}", "+"]);
    execFileSync("find", [directory, "-type", "d", "-exec", "chmod", "a-w", "{}", "+"]);
  }
  const currentPointer = join(releaseRoot, "current");
  symlinkSync(activeCommit, currentPointer);
  rewriteConfig(fixture, (lines) => [
    ...lines.filter((line) => !line.startsWith("project_dir=")),
    `release_root=${releaseRoot}`,
    `current_pointer=${currentPointer}`,
    `activation_helper_sha256=${sha256(join(fixture.root, "bin", "release-activate"))}`,
    `release_stage_sha256=${sha256(join(fixture.root, "bin", "release-stage"))}`,
    `rollout_restore_sha256=${sha256(join(fixture.root, "bin", "rollout-restore"))}`,
  ]);
  writeFileSync(join(fixture.envDir, "agent-bridge-shared"), `DB_PATH=${fixture.dbPaths[0]}\n`, { mode: 0o600 });
  writeFileSync(join(fixture.envDir, "agent-bridge-release"), `BRIDGE_CURRENT_RELEASE_DIR=${currentPointer}\n`, { mode: 0o600 });
  writeFileSync(join(releaseRoot, `.${fixture.expectedCommit}.staging-provenance.json`), JSON.stringify({
    schema_version: 1,
    commit: fixture.expectedCommit,
    archive_sha256: "b".repeat(64),
    release_stage_sha256: sha256(join(fixture.root, "bin", "release-stage")),
  }) + "\n", { mode: 0o444 });
  chmodSync(join(releaseRoot, `.${fixture.expectedCommit}.staging-provenance.json`), 0o444);
  return { currentPointer, releaseDir };
}

function writeAuthorization(fixture: Fixture, overrides: Record<string, unknown> = {}): string {
  const path = join(fixture.root, "approval.json");
  const evidencePath = join(fixture.root, "qualification-evidence.json");
  writeFileSync(evidencePath, '{"qualification":"offline-pass","commit":"' + fixture.expectedCommit + '"}\n', { mode: 0o600 });
  writeFileSync(path, JSON.stringify({
    principal: "operator@example.invalid",
    reference: "issue-183-deployment-qualification",
    approved_target_commit: fixture.expectedCommit,
    approved_at: "2026-07-26T12:00:00Z",
    expires_at: "2099-07-26T12:00:00Z",
    scope: "issue-183-production-activation",
    approved_artifact_sha256: "b".repeat(64),
    approved_evidence_sha256: sha256(evidencePath),
    approved_environment: "production-content-crawler",
    approved_rollout_helper_sha256: sha256(helperPath),
    approved_rollout_config_sha256: sha256(fixture.configFile),
    approved_activation_helper_sha256: sha256(join(fixture.root, "bin", "release-activate")),
    approved_authorization_validator_sha256: sha256(join(fixture.root, "bin", "rollout-authorization-trusted")),
    approved_acceptance_validator_sha256: sha256(join(fixture.root, "bin", "rollout-acceptance-trusted")),
    approved_release_stage_sha256: sha256(join(fixture.root, "bin", "release-stage")),
    approved_rollout_restore_sha256: sha256(join(fixture.root, "bin", "rollout-restore")),
    ...overrides,
  }) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function runAuthorizedRollout(fixture: Fixture, authorizationFile: string, overrides: Record<string, string> = {}) {
  return spawnSync("bash", [helperPath,
    "--expected-commit", fixture.expectedCommit,
    "--artifact-sha256", overrides.artifact ?? "b".repeat(64),
    "--evidence-sha256", overrides.evidence ?? sha256(join(fixture.root, "qualification-evidence.json")),
    "--environment", overrides.environment ?? "production-content-crawler",
    "--evidence-file", join(fixture.root, "qualification-evidence.json"),
    "--authorization-file", authorizationFile,
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, FAKE_CORRUPT_DB: fixture.dbPaths[0] },
  });
}

describe("guarded rollout helper", () => {
  it.each(["missing", "extra", "reordered"])("rejects %s EnvironmentFiles inventory before stopping services", (mode) => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, { FAKE_ENVIRONMENT_FILES_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.actionLog, "utf8")).not.toContain("systemctl:stop");
  });

  it.each([
    ["drop-in path", { FAKE_DROPIN_MODE: "path" }, /drop-?in/i],
    ["drop-in spaces", { FAKE_DROPIN_MODE: "spaces" }, /drop-?in/i],
    ["fragment path", { FAKE_FRAGMENT_MODE: "unexpected" }, /FragmentPath/i],
  ])("rejects an unexpected systemd %s before stopping services", (_label, environment, error) => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, environment);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(error);
    expect(readFileSync(fixture.actionLog, "utf8")).not.toContain("systemctl:stop");
  });

  it.each(["empty", "newline", "multiple-newlines"])("accepts %s-only DropInPaths output", (mode) => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, { FAKE_DROPIN_MODE: mode, FAKE_FAIL_PHASE: "inspect" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/unexpected systemd drop-in/i);
    const inventory = readdirSync(fixture.logDir).find((entry) => entry.startsWith("systemd-inventory-"));
    expect(inventory).toBeDefined();
    for (const unit of units) {
      const stem = unit.replace(/\.service$/, "");
      expect(readFileSync(join(fixture.logDir, inventory!, `${stem}.drop-in-paths`), "utf8")).toBe(
        mode === "empty" ? "" : mode === "newline" ? "\n" : "\n\n\n",
      );
    }
  });

  it("resolves the release environment file for the active pointer", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    writeFileSync(join(fixture.envDir, "agent-bridge-shared"), `DB_PATH=${fixture.dbPaths[0]}\nBRIDGE_CURRENT_RELEASE_DIR=${join(fixture.root, "wrong-current")}\n`, { mode: 0o600 });
    const result = runRollout(fixture, "inspect");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/active release pointer mismatch/i);
  });

  it("captures cat, FragmentPath, DropInPaths and EnvironmentFiles evidence for every allowlisted unit", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, { FAKE_FAIL_PHASE: "inspect" });
    expect(result.status).not.toBe(0);
    const inventory = readdirSync(fixture.logDir).find((entry) => entry.startsWith("systemd-inventory-"));
    expect(inventory).toBeDefined();
    for (const unit of units) {
      const stem = unit.replace(/\.service$/, "");
      expect(readFileSync(join(fixture.logDir, inventory!, `${stem}.cat`), "utf8")).toContain("EnvironmentFile");
      expect(readFileSync(join(fixture.logDir, inventory!, `${stem}.fragment-path`), "utf8")).toContain("systemd");
      expect(existsSync(join(fixture.logDir, inventory!, `${stem}.drop-in-paths`))).toBe(true);
      expect(existsSync(join(fixture.logDir, inventory!, `${stem}.environment-files`))).toBe(true);
    }
  }, 15_000);

  it("captures inventory only for the configured unit on a single-service host, not the full compiled allowlist", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    useMinimalInventory(fixture);
    const result = runRollout(fixture, undefined, undefined, { FAKE_FAIL_PHASE: "inspect" });
    expect(result.status).not.toBe(0);
    const actionLogContent = readFileSync(fixture.actionLog, "utf8");
    expect(actionLogContent).toContain(`systemctl:cat ${units[0]}`);
    for (const unallowedUnit of units.slice(1)) {
      expect(actionLogContent).not.toContain(`systemctl:cat ${unallowedUnit}`);
    }
  }, 15_000);

  it("captures inventory for every configured unit when multiple units are selected", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, { FAKE_FAIL_PHASE: "inspect" });
    expect(result.status).not.toBe(0);
    const actionLogContent = readFileSync(fixture.actionLog, "utf8");
    for (const unit of units) {
      expect(actionLogContent).toContain(`systemctl:cat ${unit}`);
    }
  }, 15_000);

  it("fails closed before stopping services when a configured unit's systemd inventory cannot be captured", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    useMinimalInventory(fixture);
    const result = runRollout(fixture, undefined, undefined, { FAKE_UNCAPTURABLE_UNIT: units[0] });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/systemd unit cannot be captured/i);
    expect(readFileSync(fixture.actionLog, "utf8")).not.toContain("systemctl:stop");
  }, 15_000);

  it("binds authorization to the exact artifact, evidence, environment and trusted identities before stopping services", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const approval = writeAuthorization(fixture);

    const result = runAuthorizedRollout(fixture, approval);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(JSON.parse(readFileSync(join(artifacts, "release-evidence.json"), "utf8"))).toEqual(expect.objectContaining({
      environment: "production-content-crawler",
      artifactSha256: "b".repeat(64),
      qualificationEvidenceSha256: sha256(join(fixture.root, "qualification-evidence.json")),
      rolloutConfigSha256: sha256(fixture.configFile),
      authorizationValidatorSha256: sha256(join(fixture.root, "bin", "rollout-authorization-trusted")),
      acceptanceValidatorSha256: sha256(join(fixture.root, "bin", "rollout-acceptance-trusted")),
    }));
    expect(JSON.parse(readFileSync(join(artifacts, "activation-helper-evidence.json"), "utf8"))).toEqual({ activationHelperSha256: sha256(join(fixture.root, "bin", "release-activate")) });
    expect(JSON.parse(readFileSync(join(artifacts, "trusted-helper-evidence.json"), "utf8"))).toEqual(expect.objectContaining({
      releaseStageSha256: sha256(join(fixture.root, "bin", "release-stage")),
      rolloutRestoreSha256: sha256(join(fixture.root, "bin", "rollout-restore")),
    }));
  }, 15_000);

  it("rejects an identity mismatch before stopping services", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const approval = writeAuthorization(fixture, { approved_artifact_sha256: "d".repeat(64) });

    const result = runAuthorizedRollout(fixture, approval);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/artifact/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("rejects an activation-helper identity mismatch before stopping services", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const approval = writeAuthorization(fixture, { approved_activation_helper_sha256: "e".repeat(64) });

    const result = runAuthorizedRollout(fixture, approval);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/activation_helper|activation helper/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("rejects staged provenance drift before publishing the sentinel", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const provenance = join(fixture.root, "releases", `.${fixture.expectedCommit}.staging-provenance.json`);
    chmodSync(provenance, 0o644);
    writeFileSync(provenance, JSON.stringify({ schema_version: 1, commit: fixture.expectedCommit, archive_sha256: "d".repeat(64), release_stage_sha256: sha256(join(fixture.root, "bin", "release-stage")) }) + "\n", { mode: 0o444 });
    chmodSync(provenance, 0o444);
    const approval = writeAuthorization(fixture);

    const result = runAuthorizedRollout(fixture, approval);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/staging provenance.*artifact|artifact.*staging provenance/i);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(false);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("rejects qualification evidence drift before stopping services", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const approval = writeAuthorization(fixture);
    writeFileSync(join(fixture.root, "qualification-evidence.json"), "tampered\n", { mode: 0o600 });

    const result = runAuthorizedRollout(fixture, approval);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/evidence.*SHA-256|evidence/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("requires a validated immutable current pointer before stopping services", () => {
    const fixture = createFixture();
    const releaseRoot = join(fixture.root, "releases");
    mkdirSync(releaseRoot, { recursive: true, mode: 0o755 });
    const currentPointer = join(releaseRoot, "current");
    rewriteConfig(fixture, (lines) => [
      ...lines,
      `release_root=${releaseRoot}`,
      `current_pointer=${currentPointer}`,
    ]);

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/current pointer must be a valid symlink/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("rejects a current pointer targeting a different commit before stopping services", () => {
    const fixture = createFixture();
    const releaseRoot = join(fixture.root, "releases");
    mkdirSync(releaseRoot, { recursive: true, mode: 0o755 });
    const currentPointer = join(releaseRoot, "current");
    symlinkSync("0".repeat(40), currentPointer);
    rewriteConfig(fixture, (lines) => [
      ...lines,
      `release_root=${releaseRoot}`,
      `current_pointer=${currentPointer}`,
    ]);

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/current pointer target does not match expected commit/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("rejects a rollout pointer that differs from the pointer loaded by systemd services", () => {
    const fixture = createFixture();
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    writeFileSync(join(fixture.envDir, "agent-bridge-release"), `BRIDGE_CURRENT_RELEASE_DIR=${join(fixture.root, "wrong-current")}\n`, { mode: 0o600 });

    const result = runRollout(fixture);
    execFileSync("find", [releaseDir, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/active release pointer mismatch/i);
    expect(currentPointer).not.toBe(join(fixture.root, "wrong-current"));
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("runs immutable release mode through containment and records release evidence", () => {
    const fixture = createFixture();
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);
    execFileSync("find", [releaseDir, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const releaseEvidence = JSON.parse(readFileSync(join(artifacts, "release-evidence.json"), "utf8"));
    expect(releaseEvidence).toEqual(expect.objectContaining({
      expectedCommit: fixture.expectedCommit,
      currentPointer,
      releaseDir,
      rolloutHelperSha256: sha256(helperPath),
    }));
    expect(readFileSync(join(artifacts, "release-evidence.sha256"), "utf8")).toContain("release-evidence.json");
    const log = actions(fixture);
    expect(log.indexOf("systemctl:stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("systemctl:stop")).toBeLessThan(log.indexOf(" backup "));
    expect(existsSync(join(artifacts, "containment-evidence.json"))).toBe(true);
    expect(existsSync(join(artifacts, "stopped-evidence.sha256"))).toBe(true);
    expect(existsSync(join(artifacts, "post-start-evidence.sha256"))).toBe(true);
    expect(JSON.parse(readFileSync(join(artifacts, "post-start-evidence.json"), "utf8")).restartBoundary).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(existsSync(join(artifacts, "phase-ledger.log"))).toBe(true);
    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");
    expect(ledger).toMatch(/phase=PRECHECK_STARTED/);
    expect(ledger).toMatch(/phase=SERVICES_STARTING/);
    expect(ledger).toMatch(/phase=COMPLETE/);
    expect(ledger.indexOf("phase=SERVICES_STARTING")).toBeLessThan(ledger.indexOf("phase=ACCEPTED"));
  }, 15_000);

  it("backs up and migrates a schema-3 database before reconciliation creates its audit table", () => {
    const fixture = useMinimalInventory(createFixture());
    const bridge = openDb(fixture.dbPaths[0], { serviceId: "telegram:interactive", runId: "schema-3-run" });
    bridge.insertRun("schema-3-run", "chat-1", "codex");
    const lane = bridge.acquireLock("telegram:interactive", "chat-1");
    expect(lane).not.toBeNull();
    bridge.raw.prepare("UPDATE execution_locks SET run_id = ?").run("schema-3-run");
    bridge.enqueueMsg("telegram:interactive", "chat-1", {
      prompt: "schema-3 claim",
      chatId: 1,
      chatType: "private",
      attachments: ["document:file-id"],
    });
    bridge.raw.prepare("UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?")
      .run("schema-3-run", lane!.acquisitionId);
    // Issue #351 added migration 7 (event_receipts). A genuine schema-3
    // database predates that table too, so it must be dropped here alongside
    // reconciliation_audit (migration 4) — otherwise migration 7's CREATE
    // TABLE collides with the table this fixture's earlier full openDb()
    // call already created before being rewound to user_version = 3.
    bridge.raw.exec("DROP TABLE reconciliation_audit; DROP TABLE event_receipts; DROP TABLE autonomous_goals; PRAGMA user_version = 3;");
    bridge.close();

    const result = runRollout(fixture);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).toBe(0);
    const log = actions(fixture);
    expect(log.indexOf(" stop ")).toBeLessThan(log.indexOf(" checkpoint "));
    expect(log.indexOf(" checkpoint ")).toBeLessThan(log.indexOf(" backup "));
    expect(log.indexOf(" backup ")).toBeLessThan(log.indexOf(" migrate "));
    expect(log.indexOf(" migrate ")).toBeLessThan(log.indexOf(" reconcile "));
    const verify = new Database(fixture.dbPaths[0], { readonly: true });
    try {
      expect(verify.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reconciliation_audit'").get()).toEqual({ name: "reconciliation_audit" });
      expect(verify.prepare("SELECT state, attachments_json FROM pending_messages").get()).toEqual({ state: "queued", attachments_json: '["document:file-id"]' });
    } finally {
      verify.close();
    }
  }, 20_000);

  it("completes a guarded rollout with a legitimate preflight run and lock", () => {
    const fixture = createFixture();
    const bridge = openDb(fixture.dbPaths[0], {
      serviceId: "telegram:interactive",
      runId: "bot-run",
    });
    bridge.insertRun("bot-run", "chat-1", "codex");
    expect(bridge.acquireLock("telegram:interactive", "chat-1")).not.toBeNull();
    bridge.close();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const db = new Database(fixture.dbPaths[0], { readonly: true });
    try {
      expect(db.prepare("SELECT status, error FROM bridge_runs WHERE run_id = 'bot-run'").get()).toMatchObject({
        status: "failed",
        error: "interrupted_by_controlled_rollout",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM execution_locks").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  }, 20_000);

  it("atomically activates the staged release after migration and before service start", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = actions(fixture);
    const activationLine = log.split("\n").find((line) => line.startsWith("release-activate:") && !line.includes("--validate-only"));
    expect(activationLine).toBeDefined();
    expect(log.indexOf(" migrate ")).toBeLessThan(log.indexOf(activationLine!));
    expect(log.indexOf(activationLine!)).toBeLessThan(log.indexOf("systemctl:start"));
    expect(readlinkSync(currentPointer)).toBe(fixture.expectedCommit);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(JSON.parse(readFileSync(join(artifacts, "pointer-switch-evidence.json"), "utf8"))).toEqual(expect.objectContaining({
      previousCommit: fixture.previousCommit,
      activeCommit: fixture.expectedCommit,
      pointer: currentPointer,
      transitionAt: expect.any(String),
    }));
    const beforeQueue = JSON.parse(readFileSync(join(artifacts, "preflight-evidence.json"), "utf8")).databases
      .map((entry: { path: string; pendingQueueCount: number }) => [entry.path, entry.pendingQueueCount]);
    const afterQueue = JSON.parse(readFileSync(join(artifacts, "post-start-evidence.json"), "utf8")).databases
      .map((entry: { path: string; pendingQueueCount: number }) => [entry.path, entry.pendingQueueCount]);
    expect(afterQueue).toEqual(beforeQueue);
    const beforeEvidence = JSON.parse(readFileSync(join(artifacts, "preflight-evidence.json"), "utf8"));
    expect(beforeEvidence.databases[0]).toEqual(expect.objectContaining({
      queueStateCounts: expect.any(Object),
      claimStateCounts: expect.any(Object),
      executionLockState: expect.any(Object),
      claimRunAcquisitionCorrelation: expect.any(String),
      deliveryState: expect.any(Object),
    }));
    expect(JSON.parse(readFileSync(join(artifacts, "post-start-evidence.json"), "utf8")).databases[0].claimRunAcquisitionCorrelation)
      .toBe(beforeEvidence.databases[0].claimRunAcquisitionCorrelation);
  }, 15_000);

  it("installs and verifies the cleanup timer separately after release activation", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const systemdDir = join(fixture.root, "etc", "systemd", "system");
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), "utf8")).toContain("BRIDGE_CURRENT_RELEASE_DIR");
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.timer"), "utf8")).toContain("OnCalendar=");
    const installedCleanupService = readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), "utf8");
    expect(installedCleanupService).toContain("User=rollout-test");
    expect(installedCleanupService).not.toContain("BRIDGE_USER");
    expect(existsSync(join(fixture.root, "daemon-reloaded"))).toBe(true);
    expect(existsSync(join(fixture.root, "cleanup-timer-enabled"))).toBe(true);
    expect(existsSync(join(fixture.root, "cleanup-timer-active"))).toBe(true);
    const log = actions(fixture);
    expect(log).toContain("systemctl:daemon-reload");
    expect(log).toContain("systemctl:enable agent-bridge-tmp-cleanup.timer");
    expect(log).toContain("systemctl:show agent-bridge-tmp-cleanup.timer --property=TimersCalendar --value");
  }, 15_000);

  it("rejects an installed cleanup service unit whose bytes were modified after being written", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture, undefined, undefined, { FAKE_CORRUPT_CLEANUP_UNIT: "1" });

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("installed cleanup unit hash mismatch");
  }, 20_000);

  it("replaces an existing cleanup timer installation idempotently", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const systemdDir = join(fixture.root, "etc", "systemd", "system");
    writeFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), "old service\n");
    writeFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.timer"), "old timer\n");
    writeFileSync(join(fixture.root, "cleanup-timer-enabled"), "\n");
    writeFileSync(join(fixture.root, "cleanup-timer-active"), "\n");

    const result = runRollout(fixture);

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), "utf8")).not.toBe("old service\n");
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.timer"), "utf8")).not.toBe("old timer\n");
    expect(readlinkSync(currentPointer)).toBe(fixture.expectedCommit);
  }, 15_000);

  it("restores prior cleanup unit files and timer state when installation fails", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const systemdDir = join(fixture.root, "etc", "systemd", "system");
    const priorService = "prior service\n";
    const priorTimer = "prior timer\n";
    writeFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), priorService);
    writeFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.timer"), priorTimer);
    writeFileSync(join(fixture.root, "cleanup-timer-enabled"), "\n");
    writeFileSync(join(fixture.root, "cleanup-timer-active"), "\n");

    const result = runRollout(fixture, "cleanup-timer");

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.service"), "utf8")).toBe(priorService);
    expect(readFileSync(join(systemdDir, "agent-bridge-tmp-cleanup.timer"), "utf8")).toBe(priorTimer);
    expect(existsSync(join(fixture.root, "cleanup-timer-enabled"))).toBe(true);
    expect(existsSync(join(fixture.root, "cleanup-timer-active"))).toBe(true);
    expect(readlinkSync(currentPointer)).toBe(fixture.previousCommit);
  }, 15_000);

  it("does not execute an acceptance validator supplied by the target release", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.project, "scripts", "rollout-acceptance.py"), "#!/bin/sh\necho target-owned-validator-executed >&2\nexit 91\n", { mode: 0o755 });
    chmodSync(join(fixture.project, "scripts", "rollout-acceptance.py"), 0o755);
    const { releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture);
    execFileSync("find", [releaseDir, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("target-owned-validator-executed");
  }, 15_000);

  it("restores the verified databases and previous release after a pre-start migration failure", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const before = fixture.dbPaths.map(sha256);

    const result = runRollout(fixture, "migrate");

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/FAILED_RESTORED/);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(readlinkSync(currentPointer)).toBe(fixture.previousCommit);
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units);
    expect(output).not.toContain("services remain stopped");
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");
    for (const phase of [
      "DATABASES_RESTORED",
      "POINTER_ROLLBACK_STARTED",
      "POINTER_ROLLED_BACK",
      "PREVIOUS_RELEASE_STARTING",
      "PREVIOUS_RELEASE_ACCEPTED",
      "FAILED_RESTORED",
    ]) expect(ledger).toContain("phase=" + phase);
    expect(ledger.indexOf("phase=DATABASES_RESTORED")).toBeLessThan(ledger.indexOf("phase=POINTER_ROLLBACK_STARTED"));
    expect(ledger.indexOf("phase=POINTER_ROLLED_BACK")).toBeLessThan(ledger.indexOf("phase=PREVIOUS_RELEASE_STARTING"));
    expect(ledger.indexOf("phase=PREVIOUS_RELEASE_ACCEPTED")).toBeLessThan(ledger.indexOf("phase=FAILED_RESTORED"));
  }, 15_000);

  it("recontains the cohort when previous-release recovery start fails", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_FAIL_RECOVERY_START: "1" });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(existsSync(join(artifacts, "rollback-containment-evidence.json"))).toBe(true);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("fails closed when recovery restart-counter reads are empty", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_RECOVERY_RESTART_COUNTER_EMPTY: "1" });
    const output = [result.stdout, result.stderr].join("\n");
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("does not claim stopped services when recovery containment cannot be re-proven", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", "active", { FAKE_FAIL_RECOVERY_START: "1" });
    const output = [result.stdout, result.stderr].join("\n");
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE|containment could not be re-proven/i);
    expect(output).not.toContain("services remain stopped");
  }, 15_000);

  it("recontains the running previous release when terminal recovery evidence cannot be recorded", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_FAIL_TERMINAL_RECOVERY_LEDGER: "1" });
    const output = [result.stdout, result.stderr].join("\n");
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(output).not.toContain("previous release services running and recovery health verified");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("fails closed when the previous release reports a startup journal error", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_RECOVERY_JOURNAL_ERROR: "1" });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("rechecks the previous release after smoke and recontains a service that exits", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_RECOVERY_EXIT_DURING_SMOKE: "1" });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("fails closed when recovery evidence hashing fails", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, "migrate", undefined, { FAKE_FAIL_RECOVERY_EVIDENCE_HASH: "1" });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED/);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("preserves the activated release and migrated state after a post-start failure", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const before = fixture.dbPaths.map(sha256);

    const result = runRollout(fixture, "start");

    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STOPPED_PRESERVED/);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(readlinkSync(currentPointer)).toBe(fixture.expectedCommit);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 15_000);

  it("durably records the start boundary before a start command fails", () => {
    const fixture = createFixture();
    const result = runRollout(fixture, "start");
    const output = `${result.stdout}\n${result.stderr}`;
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STOPPED_PRESERVED/);
    expect(ledger).toMatch(/phase=SERVICES_STARTING/);
    expect(ledger).not.toMatch(/phase=ACCEPTED/);
  }, 15_000);

  it("resets historical service failure counters before capturing smoke baselines", () => {
    const fixture = createFixture();
    const result = runRollout(fixture, undefined, undefined, { FAKE_RESTART_COUNTER_HISTORY: "7" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = actions(fixture);
    const resetIndex = log.indexOf("systemctl:reset-failed");
    const baselineIndex = log.indexOf(`systemctl:show ${units[0]} --property=NRestarts --value`);
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    expect(resetIndex).toBeLessThan(baselineIndex);
  }, 15_000);

  it("runs the full fixed-unit rollout sequence and writes durable evidence", () => {
    const fixture = createFixture();
    const result = runRollout(fixture);

    expect(result.status, result.stderr).toBe(0);
    const log = actions(fixture);
    const stopIndex = log.indexOf("systemctl:stop");
    expect(log.slice(0, stopIndex)).toMatch(/\sinspect\s/);
    expect(stopIndex).toBeLessThan(log.indexOf(" backup "));
    expect(log).toMatch(/\sbackup\s/);
    expect(log.indexOf(" backup ")).toBeLessThan(log.indexOf(" migrate "));
    expect(log.indexOf(" migrate ")).toBeLessThan(log.indexOf(" validate "));
    expect(log.indexOf(" validate ")).toBeLessThan(log.indexOf("systemctl:start"));
    expect(log.indexOf("systemctl:start")).toBeLessThan(log.indexOf("journalctl:"));
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units);
    expect(existsSync(fixture.backupDir)).toBe(true);
    expect(existsSync(fixture.logDir)).toBe(true);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(existsSync(join(artifacts, "backup-manifest.tsv"))).toBe(true);
    expect(existsSync(join(artifacts, "migration-evidence.json"))).toBe(true);
    expect(readFileSync(join(artifacts, "rollout.log"), "utf8")).toContain("rollout completed");
  }, 15_000);

  it("accepts a cohort that is already stopped and still proves containment before migration", () => {
    const fixture = createFixture({ initiallyStopped: true });
    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const log = actions(fixture);
    expect(log.indexOf(" inspect ")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf(" backup ")).toBeGreaterThan(log.indexOf("systemctl:stop"));
    expect(log.indexOf(" migrate ")).toBeGreaterThan(log.indexOf(" backup "));
    expect(log).toContain("systemctl:start");
  }, 15_000);

  it("removes stale empty WAL sidecars only after the cohort is contained", () => {
    const fixture = createFixture({ initiallyStopped: true });
    writeFileSync(`${fixture.dbPaths[0]}-wal`, "");
    writeFileSync(`${fixture.dbPaths[0]}-shm`, "stale shared-memory index");

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("clear-stale-sidecars");
    const log = actions(fixture);
    expect(log.indexOf("systemctl:stop")).toBeLessThan(log.indexOf(" backup "));
  }, 15_000);

  it("rejects a symlinked WAL sidecar before checkpointing", () => {
    const fixture = useMinimalInventory(createFixture({ initiallyStopped: true }));
    const victim = join(fixture.root, "wal-victim");
    writeFileSync(victim, "do-not-touch");
    symlinkSync(victim, `${fixture.dbPaths[0]}-wal`);

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toMatch(/systemctl:stop|\scheckpoint\s|\sbackup\s|\smigrate\s/);
    expect(readFileSync(victim, "utf8")).toBe("do-not-touch");
  });

  it("drains non-empty WAL sidecars offline before backing up", () => {
    const fixture = useMinimalInventory(createFixture({ initiallyStopped: true }));
    const reader = new Database(fixture.dbPaths[0]);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM pending_messages").get();
    const db = new Database(fixture.dbPaths[0]);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("INSERT INTO settings(key, value) VALUES ('wal-checkpoint-test', 'must survive checkpoint');");
    db.close();
    expect(statSync(`${fixture.dbPaths[0]}-wal`).size).toBeGreaterThan(0);
    reader.close();

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const checkpointEvidence = JSON.parse(readFileSync(join(artifacts, "checkpoint-evidence.json"), "utf8"));
    expect(checkpointEvidence.databases[0]).toEqual(expect.objectContaining({ walBytesBefore: expect.any(Number), walBytesAfter: 0 }));
    const checkpointed = new Database(fixture.dbPaths[0], { readonly: true });
    expect(checkpointed.prepare("SELECT value FROM settings WHERE key = 'wal-checkpoint-test'").pluck().get()).toBe("must survive checkpoint");
    checkpointed.close();
    const log = actions(fixture);
    expect(log.indexOf("systemctl:stop")).toBeLessThan(log.indexOf(" checkpoint "));
    expect(log.indexOf(" checkpoint ")).toBeLessThan(log.indexOf(" backup "));
  });

  it("fails closed when an offline WAL checkpoint is busy", () => {
    const fixture = useMinimalInventory(createFixture({ initiallyStopped: true }));
    const reader = new Database(fixture.dbPaths[0]);
    reader.pragma("journal_mode = WAL");
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM pending_messages").get();
    const writer = new Database(fixture.dbPaths[0]);
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_autocheckpoint = 0");
    writer.exec("INSERT INTO settings(key, value) VALUES ('wal-checkpoint-busy-test', 'must remain intact');");
    writer.close();

    const result = runRollout(fixture);
    reader.close();

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/checkpoint|busy/i);
    expect(output).toMatch(/services remain stopped|STOPPED_UNCHANGED/i);
    expect(actions(fixture)).not.toMatch(/\sbackup\s|\smigrate\s/);
  }, 15_000);

  it("attaches per-database resolving-units evidence, correctly collapsing the shared antigravity/claude/codex unit onto one database", () => {
    // Issue #135 Phase 4C.3: rollout-db.ts inspect gains a resolving-units
    // evidence field, sourced from the same unit->canonical-path resolution
    // rollout-agent-bridge.sh already proves (unit_databases), not
    // re-derived. dbPaths[0] is shared by all three antigravity/claude/codex
    // units in this fixture (see createFixture's env-file wiring above).
    const fixture = createFixture();
    const result = runRollout(fixture);
    expect(result.status, result.stderr).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "preflight-evidence.json"), "utf8"));
    const byPath: Record<string, string[]> = Object.fromEntries(
      evidence.databases.map((entry: { path: string; resolvingUnits: string[] }) => [entry.path, [...entry.resolvingUnits].sort()]),
    );
    expect(byPath[fixture.dbPaths[0]]).toEqual([
      "agent-bridge-antigravity.service",
      "agent-bridge-claude.service",
      "agent-bridge-codex.service",
    ]);
    expect(byPath[fixture.dbPaths[1]]).toEqual(["agent-bridge-discord-interactive.service"]);
    expect(byPath[fixture.dbPaths[2]]).toEqual(["agent-bridge-health.service"]);
    expect(byPath[fixture.dbPaths[3]]).toEqual(["agent-bridge-interactive.service"]);
  }, 15_000);

  it.each([
    ["missing database", { missingDb: true }, /missing database/i],
    ["unknown schema", { unknownSchema: true }, /unknown schema/i],
    ["nonzero legacy queue", { pending: 1 }, /legacy queue/i],
  ] as const)("fails preflight for %s before stopping services", (_name, options, errorPattern) => {
    const fixture = createFixture(options);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(errorPattern);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("fails closed before stopping when the installed helper hash is not pinned", () => {
    const fixture = useMinimalInventory(createFixture());
    rewriteConfig(fixture, (lines) => [...lines, `rollout_helper_sha256=${"0".repeat(64)}`]);

    const result = runRollout(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/rollout helper sha-256 mismatch/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("fails preflight when main is dirty or the expected commit differs", () => {
    const dirty = createFixture();
    writeFileSync(join(dirty.project, "untracked"), "dirty");
    const dirtyResult = runRollout(dirty);
    expect(dirtyResult.status).not.toBe(0);
    expect(`${dirtyResult.stdout}\n${dirtyResult.stderr}`).toMatch(/clean working tree/i);
    expect(actions(dirty)).not.toContain("systemctl:stop");

    const mismatch = createFixture();
    mismatch.expectedCommit = "0".repeat(40);
    const mismatchResult = runRollout(mismatch);
    expect(mismatchResult.status).not.toBe(0);
    expect(`${mismatchResult.stdout}\n${mismatchResult.stderr}`).toMatch(/expected commit/i);
    expect(actions(mismatch)).not.toContain("systemctl:stop");
  });

  it("fails closed when any service remains active after stop", () => {
    const fixture = createFixture();
    const result = runRollout(fixture, "stop");
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).toContain("systemctl:stop");
    expect(actions(fixture)).not.toMatch(/\sbackup\s/);
    expect(actions(fixture)).not.toContain("systemctl:start");
  });

  it("accepts failed/dead exit 143 when stop is nonzero but every cgroup is empty", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "failed-empty-stop-error");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units).toEqual([
      expect.objectContaining({
        unit: units[0],
        ActiveState: "failed",
        SubState: "dead",
        Result: "exit-code",
        ExecMainCode: "exited",
        ExecMainStatus: "143",
        MainPID: 0,
        ControlPID: 0,
        ControlGroup: `/agent-bridge-test/${units[0]}`,
        remainingCgroupPids: [],
      }),
    ]);
    expect(actions(fixture)).toContain(`systemctl:reset-failed ${units[0]}`);
    expect(actions(fixture).indexOf("systemctl:reset-failed")).toBeLessThan(actions(fixture).indexOf("systemctl:start"));
  });

  it("fails closed on a live cgroup member before backup or migration", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "failed-empty-live-cgroup");

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(actions(fixture)).not.toMatch(/\sbackup\s|\smigrate\s/);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units[0].remainingCgroupPids).toEqual([9876]);
  });

  it("accepts systemd's affirmative empty ControlGroup report with zero PIDs", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, "empty-controlgroup");

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
    expect(evidence.units[0]).toEqual(expect.objectContaining({
      ControlGroup: "",
      MainPID: 0,
      ControlPID: 0,
      remainingCgroupPids: [],
    }));
  });

  it.each([
    "missing-cgroup-dir",
    "unreadable-cgroup-dir",
    "unreadable-cgroup-procs",
  ])("fails closed before backup or migration when the cgroup cannot be inspected: %s", (mode) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    try {
      const result = runRollout(fixture, undefined, mode);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/CONTAINMENT INCOMPLETE/);
      expect(actions(fixture)).not.toMatch(/\sbackup\s|\smigrate\s/);
      expect(fixture.dbPaths.map(sha256)).toEqual(before);
    } finally {
      for (const unit of units) {
        const cgroup = join(fixture.cgroupRoot, "agent-bridge-test", unit);
        try {
          chmodSync(cgroup, 0o755);
          chmodSync(join(cgroup, "cgroup.procs"), 0o644);
        } catch {}
      }
    }
  });

  it.runIf(process.env.AGENT_BRIDGE_REAL_SYSTEMD_TEST === "1")(
    "accepts a real failed/dead user service that exits 143 with an empty cgroup",
    async () => {
      const fixture = useMinimalInventory(createFixture());
      const unit = units[0];
      // Safety (Phase 4C.5, issue #135): real systemd must never manage
      // anything literally named after a production Agent Bridge service,
      // even transiently. The script only ever sees the production name
      // (required by its compiled ALLOWED_UNITS allowlist); the fake
      // systemctl shim remaps it to a per-fixture-unique real unit name
      // one layer below, before ever touching the real systemd --user
      // session — see test/rolloutUat.test.ts's uniqueUnitName() for the
      // full rationale.
      const realUnit = uniqueUnitName(fixture, unit);
      const runtimeDir = `/run/user/${process.getuid()}`;
      const userEnv = {
        ...process.env,
        XDG_RUNTIME_DIR: runtimeDir,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
      };
      rmSync(fixture.cgroupRoot, { recursive: true, force: true });
      symlinkSync("/sys/fs/cgroup", fixture.cgroupRoot, "dir");
      executable(join(fixture.root, "bin", "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
export XDG_RUNTIME_DIR="${runtimeDir}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${runtimeDir}/bus"
if [ "\${1:-}" = show ] && [[ " $* " == *" --property=EnvironmentFiles "* ]]; then
  printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${2%.service} (ignore_errors=no)"
elif [ "\${1:-}" = show ] && [[ " $* " == *" --property=Environment "* ]]; then
  echo NODE_ENV=production
else
  args=()
  for arg in "$@"; do
    if [ "\$arg" = "${unit}" ]; then args+=("${realUnit}"); else args+=("\$arg"); fi
  done
  exec /usr/bin/systemctl --user "\${args[@]}"
fi
`);

      // systemctl --user is one real, shared, per-user daemon — this test
      // and the Phase 4C.5 UAT suite (test/rolloutUat.test.ts) both drive
      // it for real, so they must never run concurrently against it.
      const releaseSystemdLock = await acquireRealSystemdLock();
      try {
        const loadState = execFileSync("systemctl", ["--user", "show", realUnit, "-p", "LoadState", "--value"], { env: userEnv, encoding: "utf8" }).trim();
        if (loadState && loadState !== "not-found") {
          throw new Error(`refusing to start real-systemd UAT unit: ${realUnit} is already loaded (LoadState=${loadState})`);
        }
        execFileSync("systemd-run", [
          "--user",
          `--unit=${realUnit}`,
          "--service-type=simple",
          "--property=Restart=no",
          "/bin/sh",
          "-c",
          "trap 'exit 143' TERM; while :; do sleep 1; done",
        ], { env: userEnv, stdio: "ignore" });
        const deadline = Date.now() + 5_000;
        while (execFileSync("systemctl", ["--user", "show", realUnit, "-p", "ActiveState", "--value"], { env: userEnv, encoding: "utf8" }).trim() !== "active") {
          if (Date.now() >= deadline) throw new Error("real systemd fixture did not become active");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        const result = runRollout(fixture, "backup");
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain("all selected services verified stopped");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("CONTAINMENT INCOMPLETE");
        const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const evidence = JSON.parse(readFileSync(join(artifacts, "containment-evidence.json"), "utf8"));
        expect(evidence.units[0]).toEqual(expect.objectContaining({
          unit,
          ActiveState: "failed",
          SubState: "failed",
          ExecMainStatus: "143",
          MainPID: 0,
          ControlPID: 0,
          remainingCgroupPids: [],
        }));
      } finally {
        spawnSync("systemctl", ["--user", "stop", realUnit], { env: userEnv, stdio: "ignore" });
        spawnSync("systemctl", ["--user", "reset-failed", realUnit], { env: userEnv, stdio: "ignore" });
        releaseSystemdLock();
      }
    },
    // Generous budget: acquireRealSystemdLock() may have to wait behind
    // every real-systemd test in test/rolloutUat.test.ts (up to its own
    // 60s acquire timeout) when both files run under vitest's default
    // cross-file parallelism, on top of this test's own ~1-2s of work.
    90_000,
  );

  it.each(["backup", "migrate", "validate"])("restores every database after a pre-start %s failure", (phase) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(actions(fixture)).not.toContain("systemctl:start");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("restores byte content and original ownership, mode, and size", () => {
    const fixture = useMinimalInventory(createFixture());
    chmodSync(fixture.dbPaths[0], 0o640);
    const before = metadata(fixture.dbPaths[0]);

    const result = runRollout(fixture, "migrate");

    expect(result.status).not.toBe(0);
    expect(metadata(fixture.dbPaths[0])).toEqual(before);
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(readFileSync(join(artifacts, "backup-manifest.tsv"), "utf8")).toContain("uid\tgid\tmode\tsize");
    expect(readFileSync(join(artifacts, "backup-manifest.tsv"), "utf8")).toContain("parent_device\tparent_inode\tparent_uid\tparent_gid\tparent_mode");
  });

  it("does not follow a planted predictable restore symlink", () => {
    const fixture = useMinimalInventory(createFixture());
    const victim = join(fixture.root, "root-owned-victim");
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    symlinkSync(victim, `${fixture.dbPaths[0]}.rollout-restore`);
    const victimBefore = metadata(victim);
    const databaseBefore = metadata(fixture.dbPaths[0]);

    const result = runRollout(fixture, "migrate");

    expect(result.status).not.toBe(0);
    expect(metadata(victim)).toEqual(victimBefore);
    expect(metadata(fixture.dbPaths[0])).toEqual(databaseBefore);
    expect(lstatSync(`${fixture.dbPaths[0]}.rollout-restore`).isSymbolicLink()).toBe(true);
  });

  it("rejects active substitution of the generated restore file without modifying the victim", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "restore-source.sqlite");
    const victim = join(fixture.root, "root-owned-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET: victim,
      AGENT_BRIDGE_RESTORE_TEST_SWAP_STAGE: "after-create",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/active substitution detected/i);
    expect(metadata(victim)).toEqual(victimBefore);
    expect(readFileSync(source, "utf8")).toBe("mutated-database");
  });

  it("rejects a source parent replaced by a symlink before descriptor open", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    const expectedParent = statSync(sourceParent);
    const backup = join(fixture.root, "parent-symlink-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    const originalParent = `${sourceParent}-original`;
    const attackerParent = join(fixture.root, "attacker-parent");
    renameSync(sourceParent, originalParent);
    mkdirSync(attackerParent);
    const victim = join(attackerParent, basename(source));
    writeFileSync(victim, "do-not-touch", { mode: 0o640 });
    const victimBefore = metadata(victim);
    symlinkSync(attackerParent, sourceParent, "dir");

    const result = runRestore(source, backup, {}, expectedParent);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/source parent must not be a symlink/i);
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("rejects a source parent replaced by a different directory inode", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    const expectedParent = statSync(sourceParent);
    const backup = join(fixture.root, "parent-inode-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    renameSync(sourceParent, `${sourceParent}-original`);
    mkdirSync(sourceParent);
    writeFileSync(source, "do-not-touch", { mode: 0o640 });
    const victimBefore = metadata(source);

    const result = runRestore(source, backup, {}, expectedParent);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/parent directory identity mismatch/i);
    expect(metadata(source)).toEqual(victimBefore);
  });

  it("blocks runtime-user restore-entry replacement after inode verification", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "blocked-substitution-backup.sqlite");
    const victim = join(fixture.root, "blocked-substitution-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_SWAP_TARGET: victim,
      AGENT_BRIDGE_RESTORE_TEST_SWAP_STAGE: "after-inode-check",
      AGENT_BRIDGE_RESTORE_TEST_ATTACKER_UID: String(process.getuid()),
      AGENT_BRIDGE_RESTORE_TEST_ATTACKER_GID: String(process.getgid()),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(source)).toEqual(readFileSync(backup));
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("restores the exact parent mode after failure inside the write-disabled section", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const sourceParent = dirname(source);
    chmodSync(sourceParent, 0o775);
    const expectedMode = statSync(sourceParent).mode & 0o7777;
    const backup = join(fixture.root, "critical-failure-backup.sqlite");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });

    const result = runRestore(source, backup, { AGENT_BRIDGE_RESTORE_TEST_FAIL_STAGE: "after-write-disable" });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/injected failure/i);
    expect(statSync(sourceParent).mode & 0o7777).toBe(expectedMode);
  });

  it("fails when the final destination is not the restored descriptor inode", () => {
    const fixture = createFixture();
    const source = fixture.dbPaths[0];
    const backup = join(fixture.root, "final-inode-backup.sqlite");
    const victim = join(fixture.root, "final-inode-victim");
    writeFileSync(backup, readFileSync(source), { mode: 0o640 });
    writeFileSync(source, "mutated-database", { mode: 0o640 });
    writeFileSync(victim, "do-not-touch", { mode: 0o600 });
    const victimBefore = metadata(victim);

    const result = runRestore(source, backup, {
      AGENT_BRIDGE_RESTORE_TEST_FINAL_TARGET: victim,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/final destination inode mismatch/i);
    expect(metadata(victim)).toEqual(victimBefore);
  });

  it("supports a fixed selected-unit subset and de-duplicates shared databases", () => {
    const fixture = createFixture();
    const selected = ["agent-bridge-antigravity.service", "agent-bridge-codex.service"];
    rewriteConfig(fixture, (lines) => [
      ...lines.filter((line) => !line.startsWith("unit=") && !line.startsWith("database=")),
      ...selected.map((unit) => `unit=${unit}`),
      `database=${fixture.dbPaths[0]}`,
    ]);
    writeFileSync(fixture.stateFile, `${selected.join("\n")}\n`);

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(selected);
  });

  it.each([
    ["missing allowlist database", (fixture: Fixture) => rewriteConfig(fixture, (lines) => lines.filter((line) => line !== `database=${fixture.dbPaths[3]}`))],
    ["extra allowlist database", (fixture: Fixture) => {
      const extra = join(fixture.root, "databases", "extra.sqlite");
      createLegacyDb(extra);
      rewriteConfig(fixture, (lines) => [...lines, `database=${extra}`]);
    }],
    ["duplicate allowlist database", (fixture: Fixture) => rewriteConfig(fixture, (lines) => [...lines, `database=${fixture.dbPaths[0]}`])],
    ["mismatched unit database", (fixture: Fixture) => writeFileSync(join(fixture.envDir, "agent-bridge-interactive"), `DB_PATH=${fixture.dbPaths[2]}\n`, { mode: 0o600 })],
    ["defaulted unit database", (fixture: Fixture) => {
      writeFileSync(join(fixture.envDir, "agent-bridge-shared"), "", { mode: 0o600 });
      writeFileSync(join(fixture.envDir, "agent-bridge-codex"), "", { mode: 0o600 });
    }],
  ] as const)("aborts before stop for %s", (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/database|inventory|duplicate|default/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("runs every Git inspection through the runtime user", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture);
    expect(result.status, result.stderr).toBe(0);
    const gitChecks = actions(fixture).split("\n").filter((line) => line.includes(" /usr/bin/git "));
    expect(gitChecks.length).toBeGreaterThanOrEqual(6);
    expect(gitChecks.every((line) => line.startsWith("runuser:"))).toBe(true);
  });

  it("rejects symlinked or writable evidence roots before stopping services", () => {
    const fixture = createFixture();
    rmSync(fixture.logDir, { recursive: true });
    const target = join(fixture.root, "attacker-log-target");
    mkdirSync(target, { mode: 0o777 });
    symlinkSync(target, fixture.logDir);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it.each(["start", "smoke"])("stops services and preserves migrated evidence after a post-start %s failure", (phase) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, phase);
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  });

  it("accepts journalctl's benign no-entries marker during the smoke check", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, undefined, { FAKE_NO_JOURNAL_ENTRIES: "1" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(join(fixture.logDir, "latest"), "utf8")).toContain("/logs/");
  });

  it("contains all services when one crashes during the smoke window", () => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "delayed");
    expect(result.status).not.toBe(0);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["live-cgroup", "active"])("skips pre-start rollback when containment is incomplete: %s", (mode) => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "migrate", mode);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(output).toMatch(/rollback skipped/i);
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(output).not.toContain("services remain stopped");
  });

  it("preserves migrated evidence when post-start containment cannot be proven", () => {
    const fixture = useMinimalInventory(createFixture());
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "smoke", "live-cgroup");
    const output = `${result.stdout}\n${result.stderr}`;
    const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/CONTAINMENT INCOMPLETE/);
    expect(output).not.toContain("services remain stopped");
    expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
    expect(existsSync(join(artifacts, "migration-evidence.json"))).toBe(true);
  });

  it("rejects a concurrent rollout through the exclusive OS lock", async () => {
    const fixture = createFixture();
    const first: ChildProcess = spawn("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
      env: {
        ...process.env,
        AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
        FAKE_SYSTEMCTL_STOP_DELAY: "0.5",
        FAKE_FAIL_PHASE: "stop",
      },
      stdio: "ignore",
    });
    await waitForAction(fixture, /systemctl:stop/);
    const second = runRollout(fixture);
    expect(second.status).not.toBe(0);
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
  });

  it("runs fail-closed recovery when its caller hangs up after service stop begins", async () => {
    const fixture = useMinimalInventory(createFixture());
    const rollout: ChildProcess = spawn("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
      env: {
        ...process.env,
        AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
        FAKE_SYSTEMCTL_STOP_DELAY: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    rollout.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    rollout.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    await waitForAction(fixture, /systemctl:stop/);
    rollout.kill("SIGHUP");
    const status = await new Promise<number | null>((resolve) => rollout.once("close", (code, signal) => resolve(code ?? (signal ? 143 : null))));
    const output = `${stdout}\n${stderr}`;

    expect(status).not.toBe(0);
    expect(output).toMatch(/STATE: PRE_BACKUP_RECOVERY_INCOMPLETE/);
    expect(output).toMatch(/services remain stopped/);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "interrupted rollout must retain its sentinel for review").toBe(true);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe("");
  }, 10_000);

  it("keeps the legacy restart helper unchanged", () => {
    const restart = readFileSync(fileURLToPath(new URL("../scripts/restart-agent-bridge.sh", import.meta.url)), "utf8");
    expect(restart).toContain('systemctl restart "${units[@]}"');
    expect(restart).not.toContain("rollout-db");
  });
});

describe("interrupted-rollout sentinel (Phase 4C.4, issue #135)", () => {
  function sentinelPath(fixture: Fixture): string {
    return join(fixture.logDir, ".rollout-in-progress");
  }

  function runSentinelClear(fixture: Fixture, expectedCommit: string, artifactDir: string, env: Record<string, string> = {}) {
    return spawnSync("bash", [sentinelClearPath, "--expected-commit", expectedCommit, "--artifact-dir", artifactDir], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, ...env },
    });
  }

  it("creates the sentinel immediately and removes it on a fully successful rollout", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be removed after a DONE outcome").toBe(false);
  });

  it("fails an otherwise-successful rollout, never claiming success, when its own sentinel is replaced before cleanup", () => {
    // Cleanup must be fail-closed: if the sentinel this invocation created
    // is swapped for a different file at the same path before on_exit runs
    // (identity mismatch — different inode), the rollout must not exit 0 or
    // print a false "removed" claim, even though every rollout phase itself
    // succeeded.
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, undefined, { FAKE_TAMPER_SENTINEL_REPLACE: sentinelPath(fixture) });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/SENTINEL CLEANUP FAILED/i);
    expect(output).not.toMatch(/rollout sentinel removed/);
    expect(readFileSync(sentinelPath(fixture), "utf8")).toBe("tampered\n");
  });

  it("fails an otherwise-successful rollout, never claiming success, when its own sentinel unexpectedly disappears before cleanup", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, undefined, undefined, { FAKE_TAMPER_SENTINEL_DELETE: sentinelPath(fixture) });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/SENTINEL CLEANUP FAILED/i);
    expect(output).toMatch(/unexpectedly missing/i);
    expect(output).not.toMatch(/rollout sentinel removed/);
  });

  it("removes the sentinel after a pure precondition failure (bare re-invocation behaves identically to the first attempt)", () => {
    const dirty = useMinimalInventory(createFixture());
    writeFileSync(join(dirty.project, "untracked"), "dirty");
    const result = runRollout(dirty);
    expect(result.status).not.toBe(0);
    expect(actions(dirty)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(dirty)), "sentinel must be removed after a precondition failure — nothing was ever touched").toBe(false);
  });

  it("restarts the unchanged previous release when the cohort backup does not complete", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const before = fixture.dbPaths.map(sha256);
    const result = runRollout(fixture, "backup");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: PRE_BACKUP_RECOVERED/);
    expect(output).not.toMatch(/RESTORE_INCOMPLETE|FAILED_RESTORED|STOPPED_UNCHANGED/);
    expect(fixture.dbPaths.map(sha256)).toEqual(before);
    expect(readlinkSync(currentPointer)).toBe(fixture.previousCommit);
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual([units[0]]);
    expect(existsSync(sentinelPath(fixture)), "sentinel is removable only after previous-release recovery is proven healthy").toBe(false);

    // backup_completed=0 means backup_databases() did not finish and verify
    // the whole cohort — it does NOT mean nothing was ever written to disk.
    // The fake `cp` genuinely copies the source before the forced failure,
    // so a real, unmanifested backup file exists here. It must never be
    // treated as a valid restore source.
    const backupSetDirs = readdirSync(fixture.backupDir);
    expect(backupSetDirs.length, "a partial backup set directory is expected even though the cohort backup did not complete").toBe(1);
    const partialBackupFile = join(fixture.backupDir, backupSetDirs[0], `01-${basename(fixture.dbPaths[0])}`);
    expect(existsSync(partialBackupFile), "a partial, unmanifested backup artifact must exist and must never be treated as a valid cohort backup").toBe(true);
    expect(output).toMatch(/partial backup artifacts.*not trusted/i);
  });

  it("retains the sentinel and reports RESTORE_INCOMPLETE when the automatic restore itself fails", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
        FAKE_FAIL_PHASE: "migrate",
        FAKE_CORRUPT_DB: fixture.dbPaths[0],
        FAKE_RESTORE_FAIL: "1",
      },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: RESTORE_INCOMPLETE/);
    expect(output).not.toMatch(/FAILED_RESTORED|STOPPED_UNCHANGED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be retained — the database state is unverified, not safely known").toBe(true);
  });

  it("removes the sentinel and reports FAILED_RESTORED when migration fails but the automatic restore succeeds and is verified", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, "migrate");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: FAILED_RESTORED/);
    expect(output).not.toMatch(/RESTORE_INCOMPLETE|STOPPED_UNCHANGED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel is removed once restoration is verified — but this only means 'safe to hand to the documented recovery flow,' not 'safe to bare-retry'").toBe(false);
  });

  it("retains the sentinel and reports STOPPED_PRESERVED after a post-start failure (database already on the new schema)", () => {
    const fixture = useMinimalInventory(createFixture());
    const result = runRollout(fixture, "start");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/STATE: STOPPED_PRESERVED/);
    expect(existsSync(sentinelPath(fixture)), "sentinel must be retained — always requires operator review, never an automatic retry").toBe(true);
  });

  it("blocks a second invocation while a sentinel from an interrupted run is present, citing its recorded evidence", () => {
    const fixture = useMinimalInventory(createFixture());
    const failed = runRollout(fixture, "backup");
    expect(failed.status).not.toBe(0);
    expect(existsSync(sentinelPath(fixture))).toBe(true);
    const stopCountAfterFirstRun = actions(fixture).match(/systemctl:stop/g)?.length ?? 0;

    const second = runRollout(fixture);
    const output = `${second.stdout}\n${second.stderr}`;
    expect(second.status).not.toBe(0);
    expect(output).toMatch(/interrupted rollout sentinel already exists/i);
    expect(output).toContain(fixture.expectedCommit);
    // The second invocation must never have reached the stop phase — the
    // sentinel check happens before any precondition check. So the stop
    // count must be identical to what the first (failed) run alone produced.
    expect(actions(fixture).match(/systemctl:stop/g)?.length).toBe(stopCountAfterFirstRun);
  });

  it("auto-removes the sentinel it just created when a pre-existing artifact directory blocks the same invocation (the cleanup trap must already be active at that point)", () => {
    // Regression for the exact same-second reproduction the sentinel work
    // was built to fix: this invocation creates its own sentinel, then dies
    // on the pre-existing artifact_dir collision below — a precondition-type
    // failure (stop was never attempted) that must auto-remove the sentinel
    // it just created. A pinned timestamp (test-only seam) makes the
    // collision deterministic instead of racing the wall clock.
    const fixture = useMinimalInventory(createFixture());
    const timestamp = "20260101T000000Z";
    const artifactDir = join(fixture.logDir, `${timestamp}-${fixture.expectedCommit}`);
    mkdirSync(artifactDir, { recursive: true, mode: 0o700 });

    const result = runRollout(fixture, undefined, undefined, { AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: timestamp });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/rollout artifact directory already exists/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(fixture)), "sentinel created by this invocation must be auto-removed — the cleanup trap must be active before the artifact_dir collision check runs, not just before sentinel creation").toBe(false);
  });

  it("auto-removes the sentinel it just created when artifact/log setup fails after sentinel publication but before any service is touched", () => {
    // A second, independent gap: a failure in the artifact/log setup phase
    // (writing $log_dir/latest) that happens strictly after the sentinel is
    // published but strictly before git/service preconditions run. The
    // cleanup trap must already be active for this failure too.
    const fixture = useMinimalInventory(createFixture());
    mkdirSync(join(fixture.logDir, "latest"));

    const result = runRollout(fixture);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(sentinelPath(fixture)), "sentinel created by this invocation must be auto-removed after an artifact/log setup failure").toBe(false);
  });

  it("refuses to trust a sentinel that is a symlink, never following it", () => {
    const fixture = useMinimalInventory(createFixture());
    symlinkSync("/etc/passwd", sentinelPath(fixture));
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/sentinel is a symlink/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(lstatSync(sentinelPath(fixture)).isSymbolicLink()).toBe(true);
  });

  it("refuses to trust a sentinel with unsafe permissions", () => {
    const fixture = useMinimalInventory(createFixture());
    writeFileSync(sentinelPath(fixture), "expected_commit=0\nartifact_dir=/tmp\n");
    chmodSync(sentinelPath(fixture), 0o644);
    const result = runRollout(fixture);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/unsafe ownership or mode/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  describe("rollout-sentinel-clear.sh", () => {
    it("is executable", () => {
      execFileSync("test", ["-x", sentinelClearPath]);
    });

    it("clears a valid sentinel whose recorded values match the operator-supplied confirmation", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1];
      expect(recordedArtifactDir).toBeTruthy();

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir!);
      expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);
      expect(existsSync(sentinelPath(fixture))).toBe(false);
      expect(readFileSync(join(fixture.logDir, "sentinel-clear.log"), "utf8")).toContain(fixture.expectedCommit);

      // A fresh rollout can now proceed — precondition checks no longer see
      // a sentinel in the way. Force the retry into a new wall-clock second
      // so its artifact_dir (timestamp-derived) can't collide with the one
      // the failed run already created on disk — an orthogonal, pre-existing
      // timestamp-resolution property of artifact_dir naming, not something
      // the sentinel is meant to guard against.
      execFileSync("sleep", ["1"]);
      writeFileSync(fixture.stateFile, `${units[0]}\n`); // restore active-unit baseline the failed run tore down
      const retry = runRollout(fixture);
      expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    }, 15_000);

    it("refuses when the recorded expected_commit does not match the operator-supplied value", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const clear = runSentinelClear(fixture, "1".repeat(40), recordedArtifactDir);
      expect(clear.status).not.toBe(0);
      expect(clear.stderr).toMatch(/does not match the sentinel's recorded value/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain untouched on a mismatch").toBe(true);
    });

    it("refuses when the recorded artifact_dir does not match the operator-supplied value", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);

      const clear = runSentinelClear(fixture, fixture.expectedCommit, "/tmp/wrong-artifact-dir");
      expect(clear.status).not.toBe(0);
      expect(clear.stderr).toMatch(/does not match the sentinel's recorded value/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain untouched on a mismatch").toBe(true);
    });

    it("is a no-op when no sentinel is present", () => {
      const fixture = useMinimalInventory(createFixture());
      const clear = runSentinelClear(fixture, "0".repeat(40), "/tmp/nonexistent");
      expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);
      expect(clear.stdout).toMatch(/nothing to clear/i);
    });

    it("refuses a second, genuinely concurrent clear attempt while another clear attempt holds the same lock (Phase 4C.5, issue #135)", async () => {
      // Distinct from the "while a rollout is actively running" test below:
      // this proves clear-vs-clear contention specifically, not just
      // clear-vs-generic-lock-holder. AGENT_BRIDGE_ROLLOUT_TEST_HOLD_LOCK_MS
      // makes the race deterministic — real, unmocked flock, two real
      // rollout-sentinel-clear.sh processes, one genuinely blocking the other.
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const first: ChildProcess = spawn("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
        env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, AGENT_BRIDGE_ROLLOUT_TEST_HOLD_LOCK_MS: "1000" },
        stdio: "ignore",
      });
      try {
        const deadline = Date.now() + 2_000;
        let locked = false;
        while (Date.now() < deadline) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status !== 0) { locked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(locked, "first clear attempt never acquired the lock").toBe(true);

        const second = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir);
        expect(second.status).not.toBe(0);
        expect(second.stderr).toMatch(/a rollout is currently active/i);
      } finally {
        await new Promise<void>((resolve) => first.once("close", () => resolve()));
      }

      // The winner (first) must have actually cleared it.
      expect(existsSync(sentinelPath(fixture))).toBe(false);
    }, 30_000);

    it("refuses to acquire the lock — and leaves the sentinel completely untouched — while a rollout is actively running", async () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const before = readFileSync(sentinelPath(fixture), "utf8");

      // Restore the active-unit baseline so a second rollout can pass its
      // own preconditions far enough to hold the lock for a while — but it
      // will immediately hit the pre-existing sentinel and hang there only
      // as long as it takes to fail; to hold the lock deliberately, acquire
      // it directly instead of racing a real rollout invocation.
      const holder: ChildProcess = spawn("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive 9; sleep 5`]);
      try {
        const deadline = Date.now() + 2_000;
        let locked = false;
        while (Date.now() < deadline) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status !== 0) { locked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(locked, "lock holder never acquired the lock").toBe(true);

        const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir);
        expect(clear.status).not.toBe(0);
        expect(clear.stderr).toMatch(/a rollout is currently active/i);
      } finally {
        holder.kill();
      }
      expect(readFileSync(sentinelPath(fixture), "utf8")).toBe(before);
    });

    it("refuses to write through a symlinked sentinel-clear audit log, leaving the decoy target and the sentinel untouched", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const decoy = join(fixture.root, "decoy-target");
      writeFileSync(decoy, "do-not-touch\n");
      symlinkSync(decoy, join(fixture.logDir, "sentinel-clear.log"));

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir);
      const output = `${clear.stdout}\n${clear.stderr}`;
      expect(clear.status, output).not.toBe(0);
      expect(output).toMatch(/audit log is a symlink/i);
      expect(readFileSync(decoy, "utf8")).toBe("do-not-touch\n");
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain — the clear tool must refuse before ever touching it").toBe(true);
    });

    it("never records a false 'cleared' completion entry when sentinel removal itself fails, and leaves the sentinel in place", () => {
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir, {
        AGENT_BRIDGE_ROLLOUT_TEST_FORCE_SENTINEL_RM_FAILURE: "1",
      });
      const output = `${clear.stdout}\n${clear.stderr}`;
      expect(clear.status, output).not.toBe(0);
      expect(output).not.toMatch(/sentinel cleared/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must remain in place when removal fails").toBe(true);
      const auditContent = readFileSync(join(fixture.logDir, "sentinel-clear.log"), "utf8");
      expect(auditContent).toMatch(/action=clear_authorized/);
      expect(auditContent).not.toMatch(/action=clear_completed/);
    });

    it("reports the clear as successfully committed (exit 0, sentinel gone) even when the optional post-delete completion audit entry fails to write", () => {
      // The sentinel unlink is the commit point, not the completion audit
      // entry. A failure in that purely informational, best-effort append
      // (e.g. disk full, unwritable log) must never turn an
      // already-committed clear into an ambiguous nonzero result.
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const clear = runSentinelClear(fixture, fixture.expectedCommit, recordedArtifactDir, {
        AGENT_BRIDGE_ROLLOUT_TEST_FORCE_COMPLETION_AUDIT_FAILURE: "1",
      });
      const output = `${clear.stdout}\n${clear.stderr}`;
      expect(clear.status, output).toBe(0);
      expect(output).toMatch(/sentinel cleared/i);
      expect(output).toMatch(/warning: failed to append the optional clear_completed audit entry/i);
      expect(existsSync(sentinelPath(fixture)), "sentinel must be gone — the clear genuinely committed").toBe(false);
      const auditContent = readFileSync(join(fixture.logDir, "sentinel-clear.log"), "utf8");
      expect(auditContent).toMatch(/action=clear_authorized/);
      expect(auditContent).not.toMatch(/action=clear_completed/);
    });

    it("still exits 0 with the sentinel gone when stdout/stderr are closed and the completion audit write also fails", () => {
      // The reviewer's exact scenario: unlink is the commit point, but
      // everything after it — the confirmation echo, the completion audit
      // append, and its own warning echo on failure — must be unable to
      // flip the result. Closing both output descriptors makes even the
      // plain `echo` calls fail, proving `set +e` (not just individually
      // guarding one fallible command) is what makes this region safe.
      const fixture = useMinimalInventory(createFixture());
      const failed = runRollout(fixture, "backup");
      expect(failed.status).not.toBe(0);
      const sentinelContent = readFileSync(sentinelPath(fixture), "utf8");
      const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;

      const result = spawnSync(
        "bash",
        ["-c", 'exec "$0" "$@" 1>&- 2>&-', sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            AGENT_BRIDGE_ROLLOUT_TEST_FORCE_COMPLETION_AUDIT_FAILURE: "1",
          },
        },
      );
      expect(result.status, JSON.stringify(result)).toBe(0);
      expect(existsSync(sentinelPath(fixture)), "sentinel must be gone — the clear genuinely committed regardless of closed output descriptors").toBe(false);
    });
  });
});
