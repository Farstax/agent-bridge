import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
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

function makeRelease(options: { omit?: string[]; releaseStageContent?: Buffer; helperTag?: string } = {}): {
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
    const source = readFileSync(helper.relative);
    const content = options.helperTag
      ? Buffer.concat([source, Buffer.from(`\n# cohort:${options.helperTag}\n`)])
      : source;
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

function expectInstalledCohort(installedRoot: string, releaseRoot: string): void {
  for (const helper of AUTO_REFRESH_HELPERS) {
    const installed = readFileSync(join(installedRoot, helper.installed));
    const released = readFileSync(join(releaseRoot, helper.relative));
    expect(installed.equals(released), helper.relative).toBe(true);
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; output: string }> {
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
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

  it("serializes distinct helper cohorts from convergence through rollout completion", async () => {
    const firstRelease = makeRelease({ helperTag: "first" });
    const secondRelease = makeRelease({ helperTag: "second" });
    const installedRoot = mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-installed-"));
    installOldCohort(installedRoot);
    const configFile = join(installedRoot, "rollout.conf");
    writeFileSync(configFile, "runtime_user=content-crawler\nenvironment=production-content-crawler\nrelease_stage_sha256=bootstrap-trust-anchor\n");

    const lockFile = join(installedRoot, "deployer.lock");
    const firstStarted = join(installedRoot, "first-runner-started");
    const releaseFirst = join(installedRoot, "release-first-runner");
    const secondAttempted = join(installedRoot, "second-lock-attempted");
    const secondStarted = join(installedRoot, "second-runner-started");
    const firstRunner = join(installedRoot, "runner-first.sh");
    const secondRunner = join(installedRoot, "runner-second.sh");
    writeFileSync(firstRunner, `#!/usr/bin/env bash\nset -euo pipefail\ntouch ${JSON.stringify(firstStarted)}\nwhile [[ ! -e ${JSON.stringify(releaseFirst)} ]]; do sleep 0.02; done\n`);
    writeFileSync(secondRunner, `#!/usr/bin/env bash\nset -euo pipefail\ntouch ${JSON.stringify(secondStarted)}\n`);
    chmodSync(firstRunner, 0o755);
    chmodSync(secondRunner, 0o755);

    const spawnDeploy = (
      release: ReturnType<typeof makeRelease>,
      runner: string,
      attemptMarker?: string,
    ): ChildProcessWithoutNullStreams => spawn(
      "python3",
      [DEPLOYER, "--release", release.archive, "--approval", release.approval],
      {
        env: {
          ...process.env,
          AGENT_BRIDGE_DEPLOY_TEST: "1",
          AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT: mkdtempSync(join(tmpdir(), "agent-bridge-helper-lifecycle-stage-")),
          AGENT_BRIDGE_DEPLOY_TEST_HELPER_ROOT: installedRoot,
          AGENT_BRIDGE_DEPLOY_TEST_ROLLOUT_CONFIG: configFile,
          AGENT_BRIDGE_DEPLOY_TEST_RUNNER: runner,
          AGENT_BRIDGE_DEPLOY_TEST_LOCK_FILE: lockFile,
          ...(attemptMarker ? { AGENT_BRIDGE_DEPLOY_TEST_LOCK_ATTEMPT_MARKER: attemptMarker } : {}),
        },
      },
    );

    const first = spawnDeploy(firstRelease, firstRunner);
    await waitForFile(firstStarted);
    expectInstalledCohort(installedRoot, firstRelease.root);
    const probe = spawnSync("flock", ["-n", lockFile, "true"]);
    expect(probe.status).not.toBe(0);

    const second = spawnDeploy(secondRelease, secondRunner, secondAttempted);
    let secondWasBlocked = false;
    try {
      await waitForFile(secondAttempted);
      await new Promise((resolve) => setTimeout(resolve, 150));
      secondWasBlocked = !existsSync(secondStarted);
      expectInstalledCohort(installedRoot, firstRelease.root);
    } finally {
      writeFileSync(releaseFirst, "go\n");
    }

    const [firstResult, secondResult] = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(firstResult.code, firstResult.output).toBe(0);
    expect(secondResult.code, secondResult.output).toBe(0);
    expect(secondWasBlocked).toBe(true);
    expect(existsSync(secondStarted)).toBe(true);
    expectInstalledCohort(installedRoot, secondRelease.root);
  }, 20_000);
});
