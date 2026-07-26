import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OLD_COMMIT = "1".repeat(40);
const NEW_COMMIT = "2".repeat(40);

function makeRelease(root: string, commit: string): string {
  const release = join(root, "releases", commit);
  const releases = join(root, "releases");
  execFileSync("mkdir", ["-p", release]);
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ schema_version: 1, commit }));
  writeFileSync(join(release, "entrypoint"), "immutable\n");
  chmodSync(join(release, "manifest.json"), 0o444);
  chmodSync(join(release, "entrypoint"), 0o444);
  chmodSync(release, 0o555);
  chmodSync(releases, 0o755);
  return release;
}

function activate(root: string, expectedCommit: string): string {
  return execFileSync("python3", [
    "scripts/release-activate.py",
    "--release-root", join(root, "releases"),
    "--current", join(root, "releases", "current"),
    "--expected-commit", expectedCommit,
  ], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_RELEASE_ACTIVATE_TEST: "1" },
  });
}

function validateOnly(root: string, expectedCommit: string): string {
  return execFileSync("python3", ["scripts/release-activate.py", "--validate-only", "--release-root", join(root, "releases"), "--current", join(root, "releases", "current"), "--expected-commit", expectedCommit], { encoding: "utf8", env: { ...process.env, AGENT_BRIDGE_RELEASE_ACTIVATE_TEST: "1" } });
}

describe("atomic current release activation", () => {
  it("publishes a validated release through an atomic current symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, OLD_COMMIT);
    makeRelease(root, NEW_COMMIT);
    symlinkSync(OLD_COMMIT, join(root, "releases", "current"));

    expect(activate(root, NEW_COMMIT)).toContain(`activated ${NEW_COMMIT}`);
    expect(lstatSync(join(root, "releases", "current")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(root, "releases", "current", "manifest.json"), "utf8")).toContain(NEW_COMMIT);
  });

  it("fails closed without replacing an unexpected current path", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, NEW_COMMIT);
    writeFileSync(join(root, "releases", "current"), "not a pointer\n");

    expect(() => activate(root, NEW_COMMIT)).toThrow();
    expect(existsSync(join(root, "releases", NEW_COMMIT))).toBe(true);
    expect(lstatSync(join(root, "releases", "current")).isSymbolicLink()).toBe(false);
  });

  it("rejects a writable release before changing current", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    const release = makeRelease(root, NEW_COMMIT);
    chmodSync(join(release, "entrypoint"), 0o644);

    expect(() => activate(root, NEW_COMMIT)).toThrow();
    expect(existsSync(join(root, "releases", "current"))).toBe(false);
  });

  it("rejects a same-target pointer replacement as a no-op activation", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    makeRelease(root, NEW_COMMIT);
    symlinkSync(NEW_COMMIT, join(root, "releases", "current"));

    expect(() => activate(root, NEW_COMMIT)).toThrow(/same target|no-op/i);
    expect(readlinkSync(join(root, "releases", "current"))).toBe(NEW_COMMIT);
  });

  it("rejects a release whose manifest paths do not match the filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-pointer-"));
    const release = makeRelease(root, NEW_COMMIT);
    chmodSync(join(release, "manifest.json"), 0o644);
    writeFileSync(join(release, "manifest.json"), JSON.stringify({
      schema_version: 1,
      commit: NEW_COMMIT,
      tree: "3".repeat(40),
      package_lock_sha256: "4".repeat(64),
      files: [{ path: "missing-helper.ts", sha256: "5".repeat(64), size: 1 }],
    }));
    chmodSync(join(release, "manifest.json"), 0o444);

    expect(() => validateOnly(root, NEW_COMMIT)).toThrow(/manifest/i);
    expect(existsSync(join(root, "releases", "current"))).toBe(false);
  });
});
