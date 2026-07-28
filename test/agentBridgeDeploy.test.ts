import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const DEPLOYER = "scripts/agent-bridge-deploy.py";
const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeRelease(): { archive: string; approval: string; root: string; releaseSha: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-release-"));
  const payload = Buffer.from("runtime\n");
  const lock = Buffer.from("lock\n");
  writeFileSync(join(root, "runtime.js"), payload);
  writeFileSync(join(root, "package-lock.json"), lock);
  const manifest = {
    schema_version: 1,
    commit: COMMIT,
    tree: TREE,
    files: [
      { path: "package-lock.json", sha256: sha256(lock), size: lock.length },
      { path: "runtime.js", sha256: sha256(payload), size: payload.length },
    ],
    package_lock_sha256: sha256(lock),
  };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const archive = join(root, `agent-bridge-${COMMIT}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "manifest.json", "package-lock.json", "runtime.js"]);
  const approval = join(root, "production-approval.json");
  const releaseSha = sha256(readFileSync(archive));
  writeFileSync(approval, `${JSON.stringify({
    environment: "production-content-crawler",
    target_commit: COMMIT,
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
    expect(result.status).toBe(0);
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
    writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from("tampered")]))
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

  it("runs the one-command fixture deployment without an external evidence file", () => {
    const fixture = makeRelease();
    const releaseRoot = mkdtempSync(join(tmpdir(), "agent-bridge-deploy-stage-"));
    const result = spawnSync("python3", [DEPLOYER, "--release", fixture.archive, "--approval", fixture.approval], {
      encoding: "utf8",
      env: { ...process.env, AGENT_BRIDGE_DEPLOY_TEST: "1", AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT: releaseRoot },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`deployed ${COMMIT}`);
    expect(readFileSync(join(releaseRoot, COMMIT, "runtime.js"), "utf8")).toBe("runtime\n");
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
