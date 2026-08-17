import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const DEPLOYER = "scripts/agent-bridge-deploy.py";
const COMMIT = "4".repeat(40);
const TREE = "5".repeat(40);

const AUTO_REFRESH_HELPERS = [
  { relative: "scripts/rollout-agent-bridge.sh", pinKey: "rollout_helper_sha256", installed: "usr/local/sbin/rollout-agent-bridge" },
  { relative: "scripts/release-activate.py", pinKey: "activation_helper_sha256", installed: "usr/local/libexec/agent-bridge-release-activate" },
  { relative: "scripts/rollout-restore.py", pinKey: "rollout_restore_sha256", installed: "usr/local/libexec/agent-bridge-rollout-restore" },
  { relative: "scripts/rollout-authorization.py", pinKey: "authorization_validator_sha256", installed: "usr/local/libexec/agent-bridge-rollout-authorization.py" },
  { relative: "scripts/rollout-acceptance.py", pinKey: "acceptance_validator_sha256", installed: "usr/local/libexec/agent-bridge-rollout-acceptance.py" },
] as const;

const STABLE_RELEASE_STAGE = {
  relative: "scripts/release-stage.py",
  installed: "usr/local/libexec/agent-bridge-release-stage",
  pinKey: "release_stage_sha256",
} as const;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeRelease(options: { omit?: string[]; releaseStageContent?: Buffer } = {}): {
  archive: string;
  approval: string;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-release-"));
  const payload = Buffer.from("runtime\n");
  const lock = Buffer.from("lock\n");
  const qualification = Buffer.from(JSON.stringify({ commit: COMMIT, tree: TREE, checks: ["test", "typecheck", "architecture-lint"] }) + "\n");
  writeFileSync(join(root, "runtime.js"), payload);
  writeFileSync(join(root, "package-lock.json"), lock);
  writeFileSync(join(root, "qualification-evidence.json"), qualification);
  mkdirSync(join(root, "scripts"), { recursive: true });

  const files: Array<{ path: string; sha256: string; size: number }> = [
    { path: "package-lock.json", sha256: sha256(lock), size: lock.length },
    { path: "qualification-evidence.json", sha256: sha256(qualification), size: qualification.length },
    { path: "runtime.js", sha256: sha256(payload), size: payload.length },
  ];
  const omit = new Set(options.omit ?? []);
  for (const helper of AUTO_REFRESH_HELPERS) {
    if (omit.has(helper.relative)) continue;
    const content = readFileSync(helper.relative);
    writeFileSync(join(root, helper.relative), content);
    files.push({ path: helper.relative, sha256: sha256(content), size: content.length });
  }

  const releaseStage = options.releaseStageContent ?? readFileSync(STABLE_RELEASE_STAGE.relative);
  writeFileSync(join(root, STABLE_RELEASE_STAGE.relative), releaseStage);
  files.push({ path: STABLE_RELEASE_STAGE.relative, sha256: sha256(releaseStage), size: releaseStage.length });

  const manifest = {
    schema_version: 1,
    commit: COMMIT,
    tree: TREE,
    files,
    package_lock_sha256: sha256(lock),
  };
  writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`);

  const archive = join(root, `agent-bridge-${COMMIT}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, "manifest.json", "package-lock.json", "qualification-evidence.json", "runtime.js", "scripts"]);
  const releaseSha = sha256(readFileSync(archive));
  const approval = join(root, "production-approval.json");
  writeFileSync(approval, `${JSON.stringify({
    environment: "production-content-crawler",
    target_commit: COMMIT,
    release_sha256: releaseSha,
    approval_reference: "issue-445-helper-lifecycle",
    expires_at: "2099-08-17T23:59:59Z",
  })}\n`);
  chmodSync(approval, 0o600);
  return { archive, approval, root };
}

function installOldCohort(installedRoot: string): Map<string, Buffer> {
  const originals = new Map<string, Buffer>();
  for (const helper of AUTO_REFRESH_HELPERS) {
    const destination = join(installedRoot, helper.installed);
    mkdirSync(join(destination, ".."), { recursive: true });
    const content = Buffer.from(`old:${helper.relative}\n`);
    writeFileSync(destination, content);
    chmodSync(destination, 0o750);
    originals.set(destination, content);
  }
  const stableStage = join(installedRoot, STABLE_RELEASE_STAGE.installed);
  mkdirSync(join(stableStage, ".."), { recursive: true });
  const stableContent = Buffer.from("stable-bootstrap-release-stage\n");
  writeFileSync(stableStage, stableContent);
  chmodSync(stableStage, 0o750);
  originals.set(stableStage, stableContent);
  return originals;
}

function runDeploy(options: {
  release: ReturnType<typeof makeRelease>;
  installedRoot: string;
  configFile: string;
  extraEnv?: Record<string, string>;
  runnerProbe?: string;
}) {
  let runner: string | undefined;
  if (options.runnerProbe) {
    runner = join(options.installedRoot, "runner.sh");
    writeFileSync(runner, `#!/usr/bin/env bash\ntouch ${JSON.stringify(options.runnerProbe)}\n`);
    chmodSync(runner, 0o755);
  }
  return spawnSync("python3", [DEPLOYER, "--release", options.release.archive, "--approval", options.release.approval], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BRIDGE_DEPLOY_TEST: "1",
      AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT: mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-stage-")),
      AGENT_BRIDGE_DEPLOY_TEST_HELPER_ROOT: options.installedRoot,
      AGENT_BRIDGE_DEPLOY_TEST_ROLLOUT_CONFIG: options.configFile,
      ...(runner ? { AGENT_BRIDGE_DEPLOY_TEST_RUNNER: runner } : {}),
      ...options.extraEnv,
    },
  });
}

function expectOldCohort(originals: Map<string, Buffer>, configFile: string, originalConfig: string): void {
  for (const [path, expected] of originals) {
    expect(readFileSync(path).equals(expected), path).toBe(true);
  }
  expect(readFileSync(configFile, "utf8")).toBe(originalConfig);
}

describe("privileged helper lifecycle", () => {
  it("rolls back every helper and rollout.conf when publication fails after multiple live renames", () => {
    const release = makeRelease();
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-installed-"));
    const originals = installOldCohort(installedRoot);
    const configFile = join(installedRoot, "rollout.conf");
    const originalConfig = "runtime_user=content-crawler\nenvironment=production-content-crawler\nrelease_stage_sha256=bootstrap-trust-anchor\n";
    writeFileSync(configFile, originalConfig);
    const runnerProbe = join(installedRoot, "runner-called");

    const result = runDeploy({
      release,
      installedRoot,
      configFile,
      runnerProbe,
      extraEnv: { AGENT_BRIDGE_DEPLOY_TEST_HELPER_COMMIT_FAIL_AFTER: "2" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/failpoint after helper commit 2/i);
    expect(existsSync(runnerProbe)).toBe(false);
    expectOldCohort(originals, configFile, originalConfig);
  }, 20_000);

  it("rolls back every helper and rollout.conf when pin publication fails after the whole helper cohort is live", () => {
    const release = makeRelease();
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-installed-"));
    const originals = installOldCohort(installedRoot);
    const configFile = join(installedRoot, "rollout.conf");
    const originalConfig = "runtime_user=content-crawler\nenvironment=production-content-crawler\nrelease_stage_sha256=bootstrap-trust-anchor\n";
    writeFileSync(configFile, originalConfig);
    const runnerProbe = join(installedRoot, "runner-called");

    const result = runDeploy({
      release,
      installedRoot,
      configFile,
      runnerProbe,
      extraEnv: { AGENT_BRIDGE_DEPLOY_TEST_PIN_PUBLISH_FAIL: "1" },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/failpoint before pin publication/i);
    expect(existsSync(runnerProbe)).toBe(false);
    expectOldCohort(originals, configFile, originalConfig);
  }, 20_000);

  it("leaves the whole old cohort untouched when a release-owned helper is missing before publication", () => {
    const omitted = AUTO_REFRESH_HELPERS[AUTO_REFRESH_HELPERS.length - 1];
    const release = makeRelease({ omit: [omitted.relative] });
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-installed-"));
    const originals = installOldCohort(installedRoot);
    const configFile = join(installedRoot, "rollout.conf");
    const originalConfig = "runtime_user=content-crawler\nenvironment=production-content-crawler\nrelease_stage_sha256=bootstrap-trust-anchor\n";
    writeFileSync(configFile, originalConfig);

    const result = runDeploy({ release, installedRoot, configFile });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/release helper source is missing/i);
    expectOldCohort(originals, configFile, originalConfig);
  }, 20_000);

  it("treats release-stage as bootstrap trust instead of executing or self-refreshing the release-owned copy", () => {
    const release = makeRelease({
      releaseStageContent: Buffer.from("raise SystemExit('release-owned release-stage must not execute')\n"),
    });
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-installed-"));
    const originals = installOldCohort(installedRoot);
    const stableStagePath = join(installedRoot, STABLE_RELEASE_STAGE.installed);
    const configFile = join(installedRoot, "rollout.conf");
    const originalStagePin = "bootstrap-trust-anchor";
    writeFileSync(configFile, `runtime_user=content-crawler\nenvironment=production-content-crawler\nrelease_stage_sha256=${originalStagePin}\n`);

    const result = runDeploy({ release, installedRoot, configFile });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(stableStagePath).equals(originals.get(stableStagePath)!)).toBe(true);
    const config = readFileSync(configFile, "utf8");
    expect(config).toContain(`release_stage_sha256=${originalStagePin}`);
    for (const helper of AUTO_REFRESH_HELPERS) {
      const installed = readFileSync(join(installedRoot, helper.installed));
      const released = readFileSync(helper.relative);
      expect(installed.equals(released), helper.relative).toBe(true);
      expect(config).toContain(`${helper.pinKey}=${sha256(released)}`);
    }
  }, 20_000);
});
