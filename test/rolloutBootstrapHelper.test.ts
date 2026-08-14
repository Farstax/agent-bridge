import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

// Issue #135 Phase 4C.3: scripts/rollout-bootstrap.sh — the guarded,
// separately-invoked route for creating a genuinely missing production
// database. Distinct script from rollout-agent-bridge.sh: never invoked
// implicitly, never bundled with migration of existing databases, requires
// an exact-match operator confirmation and an explicit role, and only
// accepts role/path *pairs* from a fixed allowlist (not just a bare path).
// Coordinates with the same rollout lock file so a bootstrap can never race
// an active migrate rollout.

const helperPath = fileURLToPath(new URL("../scripts/rollout-bootstrap.sh", import.meta.url));
const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const sourceDir = fileURLToPath(new URL("../src", import.meta.url));
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url));

interface Fixture {
  root: string;
  project: string;
  newRolePath: string;
  configFile: string;
  lockFile: string;
}

const roots: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createFixture(options: { allowlist?: string[]; preExisting?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-bootstrap-"));
  roots.push(root);
  const project = join(root, "project");
  const dbDir = join(root, "databases");
  const configFile = join(root, "etc", "agent-bridge", "rollout-bootstrap.conf");
  const lockFile = join(root, "run", "lock", "agent-bridge-rollout.lock");
  const bin = join(root, "bin");
  mkdirSync(join(project, "scripts"), { recursive: true });
  mkdirSync(join(root, "etc", "agent-bridge"), { recursive: true, mode: 0o700 });
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  symlinkSync(sourceDir, join(project, "src"));
  symlinkSync(nodeModules, join(project, "node_modules"));
  symlinkSync(migrationScript, join(project, "scripts", "rollout-db.ts"));

  const newRolePath = join(dbDir, "new-role.sqlite");
  if (options.preExisting) writeFileSync(newRolePath, "already here");

  const allowlist = options.allowlist ?? [`interactive:${newRolePath}`];
  writeFileSync(configFile, [
    `project_dir=${project}`,
    "runtime_user=rollout-test",
    `node_bin=${process.execPath}`,
    ...allowlist.map((entry) => `bootstrap_role=${entry}`),
    "",
  ].join("\n"), { mode: 0o600 });

  executable(join(bin, "runuser"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --user ]; then shift 2; fi
if [ "\${1:-}" = -- ]; then shift; fi
exec "$@"
`);

  // Fakes `id -u rollout-test` as the current process's real UID by default,
  // so the "parent directory owned by the runtime user" check passes against
  // fixture directories actually created (and therefore actually owned) by
  // this test process — there is no way to chown a directory to an
  // arbitrary different UID without root. FAKE_RUNTIME_UID lets a specific
  // test override the resolved UID to something that deliberately does NOT
  // match the real directory owner, to prove the mismatch is refused.
  executable(join(bin, "id"), `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = -u ]; then
  echo "\${FAKE_RUNTIME_UID:-${process.getuid ? process.getuid() : 0}}"
  exit 0
fi
exit 1
`);

  return { root, project, newRolePath, configFile, lockFile };
}

function runBootstrapHelper(fixture: Fixture, role: string, target: string, confirm: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [helperPath, "--role", role, "--new-role", target, "--confirm-new-role", confirm], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, ...env },
  });
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try { execFileSync("rm", ["-rf", root]); } catch { /* best effort */ }
  }
});

describe("rollout-bootstrap.sh", () => {
  it("is executable", () => {
    execFileSync("test", ["-x", helperPath]);
  });

  it("bootstraps an allowlisted role/path pair for a genuinely missing database", () => {
    const fixture = createFixture();
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(fixture.newRolePath)).toBe(true);
    const db = new Database(fixture.newRolePath, { readonly: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBeGreaterThan(0);
    db.close();
  });

  it("refuses an unrecognized role name", () => {
    const fixture = createFixture();
    const res = runBootstrapHelper(fixture, "not-a-role", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown database role/i);
    expect(existsSync(fixture.newRolePath)).toBe(false);
  });

  it("refuses a role/path pair that isn't on the allowlist even when the role alone is valid", () => {
    const fixture = createFixture({ allowlist: ["discord:/nonexistent/discord.sqlite"] });
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/allowlist/i);
    expect(existsSync(fixture.newRolePath)).toBe(false);
  });

  it("refuses the correct path under the wrong role (role/path pair must match exactly, not just the path)", () => {
    const probe = createFixture();
    const target = join(probe.root, "databases", "shared.sqlite");
    const fixture = createFixture({ allowlist: [`interactive:${target}`] });
    const res = runBootstrapHelper(fixture, "discord", target, target);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/allowlist/i);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a target not on the fixed bootstrap allowlist at all", () => {
    const fixture = createFixture();
    const outsidePath = join(fixture.root, "databases", "not-allowed.sqlite");
    const res = runBootstrapHelper(fixture, "interactive", outsidePath, outsidePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/allowlist/i);
    expect(existsSync(outsidePath)).toBe(false);
  });

  it("refuses when --confirm-new-role does not exactly match --new-role", () => {
    const fixture = createFixture();
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, `${fixture.newRolePath}.other`);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/confirm-new-role/i);
    expect(existsSync(fixture.newRolePath)).toBe(false);
  });

  it("refuses when the target already exists (not a genuinely missing database)", () => {
    const fixture = createFixture({ preExisting: true });
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it("refuses when the target is a dangling symlink", () => {
    const fixture = createFixture();
    symlinkSync(join(fixture.root, "databases", "nowhere.sqlite"), fixture.newRolePath);
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/already exists/i);
  });

  it("refuses a relative target path", () => {
    const fixture = createFixture({ allowlist: ["interactive:relative/path.sqlite"] });
    const res = runBootstrapHelper(fixture, "interactive", "relative/path.sqlite", "relative/path.sqlite");
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/absolute/i);
  });

  it("refuses when the parent directory is world-writable", () => {
    const fixture = createFixture();
    execFileSync("chmod", ["0777", join(fixture.root, "databases")]);
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/writable/i);
  });

  it("refuses when the parent directory is not owned by the configured runtime user (production ownership contradiction regression)", () => {
    // Regression: an earlier version of this script required the parent
    // directory to be root-owned, then dropped to the runtime user to write
    // there — a self-contradiction, since under real permissions the
    // runtime user cannot write into a directory it doesn't own. The check
    // now resolves the runtime user's actual UID (via the id command) and
    // requires the directory to be owned by *that* UID. This test can't
    // chown a real directory to an arbitrary UID without root, so instead it
    // makes the resolved "runtime user" UID (via the fake `id` command)
    // deliberately not match the fixture directory's real owner (the test
    // process itself) — proving the mismatch is what's actually checked,
    // not merely that some ownership value happens to be logged.
    const fixture = createFixture();
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath, {
      FAKE_RUNTIME_UID: "424242",
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/must be owned by the runtime user/i);
    expect(existsSync(fixture.newRolePath)).toBe(false);
  });

  it("refuses when the parent directory is missing", () => {
    const fixture = createFixture();
    const target = join(fixture.root, "databases", "nope", "new-role.sqlite");
    const withMissingParentAllowed = createFixture({ allowlist: [`interactive:${target}`] });
    const res = runBootstrapHelper(withMissingParentAllowed, "interactive", target, target);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/missing or symlinked/i);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a malformed bootstrap_role config entry (missing the role: prefix)", () => {
    const fixture = createFixture({ allowlist: [] });
    execFileSync("bash", ["-c", `echo "bootstrap_role=${fixture.newRolePath}" >> "${fixture.configFile}"`]);
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/role:absolute-path/i);
  });

  it("refuses without a fixed config file", () => {
    const fixture = createFixture();
    execFileSync("rm", ["-f", fixture.configFile]);
    const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/missing fixed bootstrap config/i);
  });

  it("rejects a concurrent bootstrap through the exclusive OS lock shared with the main rollout script", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.root, "run", "lock"), { recursive: true });
    // Hold the lock in a background process, then attempt bootstrap concurrently.
    const holder = spawn("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive 9; sleep 5`]);
    try {
      const waitUntilLocked = spawnSync("bash", ["-c", `
        exec 9>"${fixture.lockFile}"
        for i in $(seq 1 50); do
          if ! flock --exclusive --nonblock 9; then exit 0; fi
          flock --unlock 9
          sleep 0.05
        done
        exit 1
      `]);
      expect(waitUntilLocked.status, "lock holder never acquired the lock").toBe(0);
      const res = runBootstrapHelper(fixture, "interactive", fixture.newRolePath, fixture.newRolePath);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/already active/i);
      expect(existsSync(fixture.newRolePath)).toBe(false);
    } finally {
      holder.kill();
    }
  });
});
