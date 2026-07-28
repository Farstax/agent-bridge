import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import { cleanupRoots, createFixture, helperPath } from "./support/rolloutFixture";

const DEPLOYER = "scripts/agent-bridge-deploy.py";
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(cleanupRoots);

function makeRelease(commit = COMMIT): { archive: string; approval: string; root: string; releaseSha: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-release-"));
  const payload = Buffer.from("runtime\n");
  const lock = Buffer.from("lock\n");
  const qualification = Buffer.from(JSON.stringify({ commit, tree: TREE, checks: ["test", "typecheck", "architecture-lint"] }) + "\n");
  writeFileSync(join(root, "runtime.js"), payload);
  writeFileSync(join(root, "package-lock.json"), lock);
  const manifest = {
    schema_version: 1,
    commit,
    tree: TREE,
    files: [
      { path: "package-lock.json", sha256: sha256(lock), size: lock.length },
      { path: "qualification-evidence.json", sha256: sha256(qualification), size: qualification.length },
      { path: "runtime.js", sha256: sha256(payload), size: payload.length },
    ],
    package_lock_sha256: sha256(lock),
  };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(join(root, "qualification-evidence.json"), qualification);
  const archive = join(root, `agent-bridge-${commit}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "manifest.json", "package-lock.json", "qualification-evidence.json", "runtime.js"]);
  const approval = join(root, "production-approval.json");
  const releaseSha = sha256(readFileSync(archive));
  writeFileSync(approval, `${JSON.stringify({
    environment: "production-content-crawler",
    target_commit: commit,
    release_sha256: releaseSha,
    approval_reference: "issue-183-simplified",
    expires_at: "2099-07-28T23:59:59Z",
  })}\n`);
  chmodSync(approval, 0o600);
  return { archive, approval, root, releaseSha };
}

describe("single-input deployer contract", () => {
  it("validates one archive and minimal approval without an evidence file", () => {
    const fixture = makeRelease();
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1" },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`validated ${COMMIT}`);
    expect(result.stdout).not.toMatch(/evidence|bundle|validator/i);
  });

  it("rejects a tampered archive and wrong commit/environment/SHA or expired approval", () => {
    const fixture = makeRelease();
    const approval = JSON.parse(readFileSync(fixture.approval, "utf8"));
    approval.target_commit = "3".repeat(40);
    writeFileSync(fixture.approval, `${JSON.stringify(approval)}\n`);
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/commit|approval/i);
  });

  it("rejects an archive whose bytes changed after approval", () => {
    const fixture = makeRelease();
    const tampered = join(fixture.root, "tampered.tar.gz");
    copyFileSync(fixture.archive, tampered);
    writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from("tampered")]));
    const result = spawnSync("python3", [DEPLOYER, "--release", tampered, "--approval", fixture.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/SHA-256|archive/i);
  });

  it("rejects legacy per-component identity fields in the approval", () => {
    const fixture = makeRelease();
    const approval = JSON.parse(readFileSync(fixture.approval, "utf8"));
    approval.rollout_helper_sha256 = "a".repeat(64);
    writeFileSync(fixture.approval, `${JSON.stringify(approval)}\n`);
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/approval/i);
  });

  it("rejects an approval environment that differs from the configured environment", () => {
    const fixture = makeRelease();
    const approval = JSON.parse(readFileSync(fixture.approval, "utf8"));
    approval.environment = "other-production";
    writeFileSync(fixture.approval, `${JSON.stringify(approval)}\n`);
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval, "--validate-only"], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1", AGENT_BRIDGE_DEPLOY_TEST_ENVIRONMENT: "production-content-crawler" },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/environment/i);
  });

  it("rejects test overrides before production code import when executed as root", () => {
    const canSudo = spawnSync("sudo", ["-n", "true"], { encoding: "utf8" });
    if (canSudo.status !== 0) return;
    const result = spawnSync("sudo", ["-n", "env", "AGENT_BRIDGE_DEPLOY_TEST=1", "python3", DEPLOYER, "--release", "/missing-release", "--approval", "/missing-approval", "--validate-only"], {
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/test overrides are forbidden/i);
  });

  it("uses the validated staging helper for the production staging invocation", () => {
    const source = readFileSync(DEPLOYER, "utf8");
    expect(source).toContain('"/usr/bin/python3", str(stage_helper)');
    expect(source).not.toContain('str(staging_helper)');
  });

  it("runs the one-command fixture deployment without an external evidence file", () => {
    const fixture = makeRelease();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-stage-"));
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1", AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT: releaseRoot },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`deployed ${COMMIT}`);
    expect(readFileSync(join(releaseRoot, COMMIT, "runtime.js"), "utf8")).toBe("runtime\n");
  });

  it("hands the one-command deployment into the existing containment and acceptance state machine", () => {
    const fixture = createFixture();
    const release = makeRelease(fixture.expectedCommit);
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-state-"));
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-installed-"));
    const installedDeployer = join(installedRoot, "sbin", "agent-bridge-deploy");
    const installedStage = join(installedRoot, "libexec", "agent-bridge-release-stage");
    mkdirSync(join(installedRoot, "sbin"), { recursive: true });
    mkdirSync(join(installedRoot, "libexec"), { recursive: true });
    copyFileSync(DEPLOYER, installedDeployer);
    copyFileSync("scripts/release-stage.py", installedStage);
    chmodSync(installedDeployer, 0o750);
    chmodSync(installedStage, 0o750);
    const result = spawnSync("python3", [installedDeployer, "--release", release.archive, "--approval", release.approval], {
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_BRIDGE_DEPLOY_TEST: "1",
        AGENT_BRIDGE_DEPLOY_TEST_STAGE_HELPER: installedStage,
        AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT: releaseRoot,
        AGENT_BRIDGE_DEPLOY_TEST_RUNNER: helperPath,
        AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
        FAKE_CORRUPT_DB: fixture.dbPaths[0],
      },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`deployed ${fixture.expectedCommit}`);
    expect(existsSync(join(fixture.root, "started"))).toBe(true);
    const artifactDir = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
    expect(JSON.parse(readFileSync(join(artifactDir, "deployment-result.json"), "utf8"))).toEqual(expect.objectContaining({
      status: "complete",
      targetCommit: fixture.expectedCommit,
      artifactSha256: release.releaseSha,
      environment: "production-content-crawler",
      approvalReference: "issue-183-simplified",
    }));
  });

  it("exposes exactly the two operator inputs and rejects the old multi-file flags", () => {
    const help = spawnSync("python3", [DEPLOYER, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--release");
    expect(help.stdout).toContain("--approval");
    expect(help.stdout).not.toContain("--evidence-file");
    expect(help.stdout).not.toContain("--artifact-sha256");
  });
});
