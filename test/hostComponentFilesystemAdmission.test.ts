// Regression coverage for PR #871's filesystem-aware host-component disk
// admission and legacy (pre-phase-protocol) previous-release bootstrap path
// (issue #866). rollout-agent-bridge.sh's own admission logic is what is
// under test here - the fixture's fake release-activate binary never
// invokes real installers, so these tests exercise exactly the boundary
// the orchestrator itself controls: parsing each release's declared host
// components, charging bytes to the correct destination filesystem, and
// refusing before service containment when capacity cannot be proven.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actions, cleanupRoots, createFixture, executable, prepareImmutableRelease, runRollout, useMinimalInventory } from "./support/rolloutFixture.js";

afterEach(cleanupRoots);

const FAKE_INSTALLER = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --print-required-bytes ]; then
  if [[ "\${0##*/}" == install-cursor-* && "\${AGENT_BRIDGE_CURSOR_ACP_USER:-}" != rollout-test ]]; then
    echo "cursor preflight did not receive its configured runtime user" >&2
    exit 1
  fi
  printf '%s\\n' "\${FAKE_REQUIRED_BYTES:-0}"
  exit 0
fi
echo "host_component_status=no_op"
`;

function writeHostComponentPackageJson(releaseDir: string, hostComponents: unknown[]): void {
  unlockReleaseDir(releaseDir);
  writeFileSync(join(releaseDir, "package.json"), JSON.stringify({ type: "module", agentBridge: { hostComponents } }) + "\n");
  lockReleaseDir(releaseDir);
}

function unlockReleaseDir(releaseDir: string): void {
  execFileSync("chmod", ["-R", "u+w", releaseDir]);
}

function lockReleaseDir(releaseDir: string): void {
  execFileSync("chmod", ["-R", "a-w", releaseDir]);
}

function writeFakeInstaller(releaseDir: string, name: string): void {
  unlockReleaseDir(releaseDir);
  mkdirSync(join(releaseDir, "scripts"), { recursive: true });
  executable(join(releaseDir, "scripts", name), FAKE_INSTALLER);
  lockReleaseDir(releaseDir);
}

describe("host-component filesystem-aware disk admission", { timeout: 30_000 }, () => {
  it("charges cursor-acp preparation to the runtime user's home destination, separately from the managed /opt root", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const cursorHome = join(fixture.root, "cursor-home");
    const hostComponentRoot = join(fixture.root, "host-components");
    mkdirSync(cursorHome, { recursive: true });
    mkdirSync(hostComponentRoot, { recursive: true });

    for (const dir of [releaseDir, previousDir]) {
      writeFakeInstaller(dir, "install-agy-fake.sh");
      writeFakeInstaller(dir, "install-cursor-fake.sh");
      writeHostComponentPackageJson(dir, [
        { id: "agy-acp", installer: "scripts/install-agy-fake.sh", phase_protocol: 1 },
        { id: "cursor-acp", installer: "scripts/install-cursor-fake.sh", phase_protocol: 1 },
      ]);
    }

    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: cursorHome,
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: hostComponentRoot,
      FAKE_REQUIRED_BYTES: "2048",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toMatch(/host preparation admission/);
    expect(output).toMatch(/host_component_target_cursor-acp=2048/);
    expect(output).toMatch(/host_component_target_agy-acp=2048/);
    // Cursor's own preflight call must run as the configured runtime user,
    // never as whoever invoked the rollout.
    expect(actions(fixture)).toMatch(/runuser:--user rollout-test -- .*install-cursor-fake\.sh --print-required-bytes/);
    expect(actions(fixture)).not.toMatch(/runuser:--user rollout-test -- .*install-agy-fake\.sh --print-required-bytes/);
  });

  it("refuses host-component preparation before containment when the runtime-user home lacks capacity", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const cursorHome = join(fixture.root, "cursor-home");
    mkdirSync(cursorHome, { recursive: true });

    for (const dir of [releaseDir, previousDir]) {
      writeFakeInstaller(dir, "install-cursor-fake.sh");
      writeHostComponentPackageJson(dir, [{ id: "cursor-acp", installer: "scripts/install-cursor-fake.sh", phase_protocol: 1 }]);
    }

    const activeBefore = readFileSync(fixture.stateFile, "utf8");
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: cursorHome,
      FAKE_REQUIRED_BYTES: "2048",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "1",
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1048576",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/insufficient disk for host-component preparation/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(activeBefore);
  });

  it("reserves a conservative rollback allocation for a legacy previous release instead of invoking phase semantics", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const hostComponentRoot = join(fixture.root, "host-components");
    const installedPayload = join(hostComponentRoot, "agy-acp", "payload.bin");
    mkdirSync(dirname(installedPayload), { recursive: true });
    writeFileSync(installedPayload, Buffer.alloc(1000, "x"));

    // Target release is fully phased and declares nothing legacy.
    writeFakeInstaller(releaseDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(releaseDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh", phase_protocol: 1 }]);
    // Previous (currently active) release predates the phase protocol.
    writeFakeInstaller(previousDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(previousDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh" }]);

    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: hostComponentRoot,
      FAKE_REQUIRED_BYTES: "0",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260924T000000Z",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    // 1000 bytes on disk x the default 4x safety factor.
    expect(output).toMatch(/host_component_previous_agy-acp=4000/);
    expect(actions(fixture)).not.toContain(`release-activate:--release-root ${releaseRoot} --current ${currentPointer} --expected-commit ${fixture.previousCommit} --prepare-host-components`);
    const previousEvidence = JSON.parse(readFileSync(
      join(fixture.logDir, `20260924T000000Z-${fixture.expectedCommit}`, "host-components-previous-prepared.json"),
      "utf8",
    ));
    expect(previousEvidence).toEqual({ status: "legacy_rollback_reserved" });
  });

  it("reserves a legacy cursor-acp previous release's rollback allocation from its actual runtime-home install root, not the managed /opt root", () => {
    // Current main declares cursor-acp without phase_protocol, so this is
    // exactly the first-rollout-from-legacy-main scenario: install-cursor-acp.sh
    // has always installed beneath the runtime user's home
    // (~/.local/share/agent-bridge/cursor-acp), never under the root-owned
    // /opt/agent-bridge/host-components tree every other managed component
    // uses. Measuring the wrong root here would find nothing, report
    // "unbounded", and refuse a rollout that should be safe to proceed.
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const cursorHome = join(fixture.root, "cursor-home");
    const installedPayload = join(cursorHome, ".local", "share", "agent-bridge", "cursor-acp", "payload.bin");
    mkdirSync(dirname(installedPayload), { recursive: true });
    writeFileSync(installedPayload, Buffer.alloc(1000, "x"));
    // The managed /opt root exists but is deliberately empty: if the fix
    // regresses back to measuring this path for cursor-acp, this directory
    // being present-but-empty still yields "unbounded" (no files to walk),
    // proving the reservation genuinely comes from the runtime home.
    const hostComponentRoot = join(fixture.root, "host-components");
    mkdirSync(hostComponentRoot, { recursive: true });

    // Target release is fully phased and declares nothing legacy.
    writeFakeInstaller(releaseDir, "install-cursor-fake.sh");
    writeHostComponentPackageJson(releaseDir, [{ id: "cursor-acp", installer: "scripts/install-cursor-fake.sh", phase_protocol: 1 }]);
    // Previous (currently active) release predates the phase protocol -
    // matching current main's actual cursor-acp declaration.
    writeFakeInstaller(previousDir, "install-cursor-fake.sh");
    writeHostComponentPackageJson(previousDir, [{ id: "cursor-acp", installer: "scripts/install-cursor-fake.sh" }]);

    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: cursorHome,
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: hostComponentRoot,
      FAKE_REQUIRED_BYTES: "0",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260924T000002Z",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    // 1000 bytes on disk x the default 4x safety factor.
    expect(output).toMatch(/host_component_previous_cursor-acp=4000/);
    // Charged to the runtime home's filesystem, not the (empty) /opt root.
    expect(output).toMatch(new RegExp(`host preparation admission device=\\S+ path=${cursorHome.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`));
    expect(actions(fixture)).not.toContain(`release-activate:--release-root ${releaseRoot} --current ${currentPointer} --expected-commit ${fixture.previousCommit} --prepare-host-components`);
    const previousEvidence = JSON.parse(readFileSync(
      join(fixture.logDir, `20260924T000002Z-${fixture.expectedCommit}`, "host-components-previous-prepared.json"),
      "utf8",
    ));
    expect(previousEvidence).toEqual({ status: "legacy_rollback_reserved" });
  });

  it("reserves zero rollback bytes for a legacy component that never created its managed root", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const hostComponentRoot = join(fixture.root, "host-components");
    mkdirSync(hostComponentRoot, { recursive: true });
    // The component's managed root has never existed, so the legacy release
    // has no installed footprint to restore on rollback.

    writeFakeInstaller(releaseDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(releaseDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh", phase_protocol: 1 }]);
    writeFakeInstaller(previousDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(previousDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh" }]);

    const activeBefore = readFileSync(fixture.stateFile, "utf8");
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: hostComponentRoot,
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260925T000003Z",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(activeBefore);
    const previousEvidence = JSON.parse(readFileSync(
      join(fixture.logDir, `20260925T000003Z-${fixture.expectedCommit}`, "host-components-previous-prepared.json"),
      "utf8",
    ));
    expect(previousEvidence).toEqual({ status: "legacy_rollback_reserved" });
  });

  it("refuses before containment when an inadequately provisioned legacy rollback allocation does not fit", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);
    const hostComponentRoot = join(fixture.root, "host-components");
    const installedPayload = join(hostComponentRoot, "agy-acp", "payload.bin");
    mkdirSync(dirname(installedPayload), { recursive: true });
    writeFileSync(installedPayload, Buffer.alloc(1000, "x"));

    writeFakeInstaller(releaseDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(releaseDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh", phase_protocol: 1 }]);
    writeFakeInstaller(previousDir, "install-agy-fake.sh");
    writeHostComponentPackageJson(previousDir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh" }]);

    const activeBefore = readFileSync(fixture.stateFile, "utf8");
    const result = runRollout(fixture, undefined, undefined, {
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: hostComponentRoot,
      FAKE_REQUIRED_BYTES: "0",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "1",
      AGENT_BRIDGE_ROLLOUT_SAFETY_RESERVE_BYTES: "1",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toMatch(/insufficient disk for host-component preparation/);
    expect(output).toMatch(/host_component_previous_agy-acp=4000/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(activeBefore);
  });

  it("prepares a previous release normally when it fully supports the phase protocol", () => {
    const fixture = useMinimalInventory(createFixture());
    const { currentPointer, releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const releaseRoot = dirname(currentPointer);
    const previousDir = join(releaseRoot, fixture.previousCommit);

    for (const dir of [releaseDir, previousDir]) {
      writeFakeInstaller(dir, "install-agy-fake.sh");
      writeHostComponentPackageJson(dir, [{ id: "agy-acp", installer: "scripts/install-agy-fake.sh", phase_protocol: 1 }]);
    }

    const result = runRollout(fixture, undefined, undefined, {
      FAKE_REQUIRED_BYTES: "0",
      AGENT_BRIDGE_ROLLOUT_AVAILABLE_BYTES: "999999999999",
      AGENT_BRIDGE_ROLLOUT_TEST_TIMESTAMP: "20260924T000001Z",
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(actions(fixture)).toContain(`release-activate:--release-root ${releaseRoot} --current ${currentPointer} --expected-commit ${fixture.previousCommit} --prepare-host-components`);
    const previousEvidence = JSON.parse(readFileSync(
      join(fixture.logDir, `20260924T000001Z-${fixture.expectedCommit}`, "host-components-previous-prepared.json"),
      "utf8",
    ));
    expect(previousEvidence).toEqual({ status: "prepared" });
  });
});
