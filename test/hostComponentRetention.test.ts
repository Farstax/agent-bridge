import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRoots, createFixture, prepareImmutableRelease, runRollout, type Fixture } from "./support/rolloutFixture.js";

afterEach(cleanupRoots);

type Pins = { agy?: string; cursor?: string };

function pinRelease(fixture: Fixture, commit: string, pins: Pins | null) {
  const directory = join(fixture.root, "releases", commit);
  execFileSync("chmod", ["-R", "u+w", directory]);
  if (pins) {
    mkdirSync(join(directory, "dist", "providers"), { recursive: true });
    writeFileSync(join(directory, "dist", "providers", "acpRegistry.js"),
      `const pins = ${JSON.stringify(pins)};\nexport function getLockedAcpRegistryEntry(id) { return pins[id] ? { version: pins[id] } : null; }\n`);
  }
  execFileSync("chmod", ["-R", "a-w", directory]);
}

function installVersions(fixture: Fixture, versions: string[]) {
  const agyRoot = join(fixture.root, "host-components", "agy-acp", "components");
  const cursorHome = join(fixture.root, "cursor-home");
  const cursorRoot = join(cursorHome, ".local", "share", "agent-bridge", "cursor-acp", "versions");
  for (const version of versions) {
    mkdirSync(join(agyRoot, version, "linux-x86_64"), { recursive: true });
    writeFileSync(join(agyRoot, version, "linux-x86_64", "agy_acp_server.par"), version);
    mkdirSync(join(cursorRoot, version, "dist-package"), { recursive: true });
    writeFileSync(join(cursorRoot, version, "dist-package", "cursor-agent"), version);
  }
  const agyLink = join(fixture.root, "agy_acp_server.par");
  return {
    agyRoot,
    cursorRoot,
    cursorHome,
    agyLink,
    env: {
      AGENT_BRIDGE_ROLLOUT_HOST_COMPONENT_ROOT: join(fixture.root, "host-components"),
      AGENT_BRIDGE_ROLLOUT_RUNTIME_HOME: cursorHome,
      AGENT_BRIDGE_AGY_ACP_LINK: agyLink,
    },
  };
}

function linkCurrent(paths: ReturnType<typeof installVersions>, version: string) {
  symlinkSync(join(paths.agyRoot, version, "linux-x86_64", "agy_acp_server.par"), paths.agyLink);
  mkdirSync(join(paths.cursorHome, ".local", "bin"), { recursive: true });
  symlinkSync(join(paths.cursorRoot, version, "dist-package", "cursor-agent"), join(paths.cursorHome, ".local", "bin", "cursor-agent"));
}

describe("provider binary retention after accepted rollout", () => {
  it("keeps only the current and rollback pinned versions", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "3.0.0", cursor: "3.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0", "3.0.0"]);
    linkCurrent(paths, "3.0.0");

    const result = runRollout(fixture, undefined, undefined, paths.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    for (const root of [paths.agyRoot, paths.cursorRoot]) {
      expect(existsSync(join(root, "1.0.0"))).toBe(false);
      expect(existsSync(join(root, "2.0.0"))).toBe(true);
      expect(existsSync(join(root, "3.0.0"))).toBe(true);
    }
    expect(output).toContain("host component retention provider=agy pruned=1 retained_current=3.0.0 retained_rollback=2.0.0");
    expect(output).toContain("host component retention provider=cursor pruned=1 retained_current=3.0.0 retained_rollback=2.0.0");
  }, 20_000);

  it("keeps a version shared by current and rollback releases", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "2.0.0", cursor: "2.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0"]);

    const result = runRollout(fixture, undefined, undefined, paths.env);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(paths.agyRoot, "1.0.0"))).toBe(false);
    expect(existsSync(join(paths.agyRoot, "2.0.0"))).toBe(true);
  }, 20_000);

  it("fails closed when the rollback release pin is unavailable", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "3.0.0", cursor: "3.0.0" });
    pinRelease(fixture, fixture.previousCommit, null);
    const paths = installVersions(fixture, ["1.0.0", "2.0.0", "3.0.0"]);

    const result = runRollout(fixture, undefined, undefined, paths.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("host component retention skipped provider=agy reason=rollback_pin_unavailable");
    for (const version of ["1.0.0", "2.0.0", "3.0.0"]) expect(existsSync(join(paths.agyRoot, version))).toBe(true);
  }, 20_000);

  it("fails closed while an interrupted install is staged", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "3.0.0", cursor: "3.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0", "3.0.0"]);
    mkdirSync(join(paths.agyRoot, "..", ".install-4.0.0.abc123"));

    const result = runRollout(fixture, undefined, undefined, paths.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("host component retention skipped provider=agy reason=install_in_progress");
    expect(existsSync(join(paths.agyRoot, "1.0.0"))).toBe(true);
    expect(existsSync(join(paths.cursorRoot, "1.0.0"))).toBe(false);
  }, 20_000);

  it("fails closed when the managed link targets a non-current version", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "3.0.0", cursor: "3.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0", "3.0.0"]);
    linkCurrent(paths, "1.0.0");

    const result = runRollout(fixture, undefined, undefined, paths.env);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("host component retention skipped provider=agy reason=link_not_current");
    expect(output).toContain("host component retention skipped provider=cursor reason=link_not_current");
    expect(existsSync(join(paths.agyRoot, "1.0.0"))).toBe(true);
  }, 20_000);

  it("fails closed when the current pinned version is not installed", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "4.0.0", cursor: "4.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0"]);

    const result = runRollout(fixture, undefined, undefined, paths.env);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(paths.agyRoot, "1.0.0"))).toBe(true);
    expect(existsSync(join(paths.cursorRoot, "1.0.0"))).toBe(true);
  }, 20_000);

  it("does not prune when the rollout fails before acceptance", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    pinRelease(fixture, fixture.expectedCommit, { agy: "3.0.0", cursor: "3.0.0" });
    pinRelease(fixture, fixture.previousCommit, { agy: "2.0.0", cursor: "2.0.0" });
    const paths = installVersions(fixture, ["1.0.0", "2.0.0", "3.0.0"]);

    const result = runRollout(fixture, "start", undefined, paths.env);

    expect(result.status).not.toBe(0);
    expect(existsSync(join(paths.agyRoot, "1.0.0"))).toBe(true);
    expect(existsSync(join(paths.cursorRoot, "1.0.0"))).toBe(true);
  }, 20_000);
});
