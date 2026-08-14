// Phase 4C.5 (issue #135): UAT matrix against a non-production fixture
// environment (docs/roadmap/issue-135-phase4c-migration-ownership.md §11,
// rows tagged "UAT, non-production fixture environment").
//
// Unlike test/rolloutHelper.test.ts (which fakes `systemctl` entirely),
// every test in this file drives *real* `systemd --user` units: real
// process start/stop, real ActiveState/SubState/ExecMainStatus, real
// cgroups, real SIGTERM/SIGKILL semantics. `runuser`/`cp`/`journalctl`/
// `rollout-restore` stay fixture-shimmed for the same reason the existing
// suite shims them (no real "rollout-test" OS user, no desire to touch
// the real cgroup root) — outside an explicitly injected failure phase,
// the runuser shim exec's the real rollout-db.ts against real SQLite
// databases either way.
//
// SAFETY: rollout-agent-bridge.sh's compiled ALLOWED_UNITS allowlist
// requires the *config* to list the exact seven production unit names —
// that allowlist is itself under test and must never be loosened. Real
// systemd, however, never touches anything named after a real Agent
// Bridge service: the fake systemctl shim (useRealSystemctl below)
// remaps every unit-name argument to a per-fixture-unique name
// (uniqueUnitName) one layer below the script, before ever forwarding to
// a genuine `systemctl --user` call. Setup also fails closed if a target
// unique name is already loaded or its unit file already exists, and
// tracks everything it creates so a partial failure can be torn down
// completely rather than leaking real systemd state.
//
// Gated behind AGENT_BRIDGE_REAL_SYSTEMD_TEST=1, matching the one
// existing real-systemd test in rolloutHelper.test.ts, so ordinary CI
// runs (which may not have a user systemd session) stay fast and skip
// this file entirely.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRealSystemdLock,
  cleanupRoots,
  createFixture,
  executable,
  type Fixture,
  helperPath,
  metadata,
  runRestore,
  runRollout,
  seedRoleFixtures,
  sentinelClearPath,
  sha256,
  uniqueUnitName,
  units,
} from "./support/rolloutFixture";

const REAL_SYSTEMD = process.env.AGENT_BRIDGE_REAL_SYSTEMD_TEST === "1";

afterEach(cleanupRoots);

const runtimeDir = `/run/user/${process.getuid?.() ?? 0}`;
const userEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: runtimeDir,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
};

function systemctlUser(args: string[]) {
  return spawnSync("systemctl", ["--user", ...args], { env: userEnv, encoding: "utf8" });
}

function observedHeadDir(fixture: Fixture): string {
  return join(fixture.root, "observed-head");
}

/** What project commit the real placeholder process observed at its most
 * recent start — proof the *restarted process*, not just the git working
 * tree, actually saw the code it's supposed to have.
 */
function observedHead(fixture: Fixture, productionUnit: string): string {
  const path = join(observedHeadDir(fixture), `${productionUnit}.head`);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

/** Swaps the fixture's fake `systemctl` for a shim that forwards real
 * lifecycle commands (stop/start/is-active/is-failed/reset-failed) to a
 * genuine `systemctl --user` session, while still canning the
 * config-introspection properties the script needs:
 * - EnvironmentFiles/Environment: a transient/runtime unit has no on-disk
 *   EnvironmentFile= the way a real installed unit would.
 * - ControlGroup: optionally overridden via FAKE_REAL_CONTROLGROUP_OVERRIDE
 *   (Phase 4C.5) so a UAT test can prove containment-cannot-be-re-proven
 *   under real systemd by injecting only a bad evidence read — never by
 *   touching the real cgroup filesystem.
 * Every unit-name argument to every real systemctl call is remapped via
 * uniqueUnitName() first — see the SAFETY note at the top of this file.
 */
function useRealSystemctl(fixture: Fixture): void {
  rmSync(fixture.cgroupRoot, { recursive: true, force: true });
  symlinkSync("/sys/fs/cgroup", fixture.cgroupRoot, "dir");
  const mapEntries = units.map((unit) => `  [${unit}]="${uniqueUnitName(fixture, unit)}"`).join("\n");
  executable(join(fixture.root, "bin", "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl:$*" >> "${fixture.actionLog}"
export XDG_RUNTIME_DIR="${runtimeDir}"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${runtimeDir}/bus"
declare -A UAT_UNIT_MAP=(
${mapEntries}
)
if [ "\${1:-}" = show ] && [[ " $* " == *" --property=EnvironmentFiles "* ]]; then
  printf '%s\n%s\n' "${fixture.envDir}/agent-bridge-shared (ignore_errors=yes)" "${fixture.envDir}/\${2%.service} (ignore_errors=no)"
elif [ "\${1:-}" = show ] && [[ " $* " == *" --property=Environment "* ]]; then
  echo NODE_ENV=production
elif [ "\${1:-}" = show ] && [[ " $* " == *" --property=ControlGroup "* ]] && [ -n "\${FAKE_REAL_CONTROLGROUP_OVERRIDE:-}" ]; then
  echo "\${FAKE_REAL_CONTROLGROUP_OVERRIDE}"
else
  args=()
  for arg in "$@"; do
    if [[ -n "\${UAT_UNIT_MAP[\$arg]:-}" ]]; then args+=("\${UAT_UNIT_MAP[\$arg]}"); else args+=("\$arg"); fi
  done
  exec /usr/bin/systemctl --user "\${args[@]}"
fi
`);
}

/** Unit-file content for one production unit: on every start, records the
 * project's current commit to an observed-head file (Phase 4C.5) before
 * becoming a long-lived, TERM-trapping placeholder — proving the
 * *restarted process*, not just `git rev-parse HEAD`, saw the reverted
 * code.
 */
function unitFileContent(fixture: Fixture, productionUnit: string): string {
  const headFile = join(observedHeadDir(fixture), `${productionUnit}.head`);
  return `[Service]
Type=simple
Restart=no
ExecStart=/bin/sh -c 'git -C "${fixture.project}" rev-parse HEAD > "${headFile}" 2>/dev/null || true; trap "exit 143" TERM; while :; do sleep 1; done'
`;
}

/** Starts one real, long-lived, TERM-trapping placeholder unit per
 * configured service name, as genuine unit files under the runtime user's
 * systemd directory — not `systemd-run` transients, which systemd
 * garbage-collects entirely once stopped, making a subsequent
 * `systemctl start` fail with "Unit not found". A real installed unit
 * (which is what every agent-bridge production service actually is)
 * survives stop/start cycles, which several of these UAT drills genuinely
 * exercise.
 *
 * Fails closed if any target unique unit name is already loaded or its
 * unit file already exists (Phase 4C.5), and is transactional: any
 * failure partway through tears down everything created so far before
 * rethrowing, rather than leaking real systemd state on a partial setup
 * failure. Returns a teardown that stops every unit, clears failed
 * state, and removes the unit files.
 */
async function startRealUnits(fixture: Fixture, productionUnits: string[]): Promise<() => void> {
  const unitDir = join(runtimeDir, "systemd", "user");
  mkdirSync(observedHeadDir(fixture), { recursive: true });
  const created: Array<{ productionUnit: string; uniqueUnit: string; unitFile: string }> = [];

  const teardownCreated = () => {
    for (const { uniqueUnit, unitFile } of created) {
      systemctlUser(["stop", uniqueUnit]);
      systemctlUser(["reset-failed", uniqueUnit]);
      rmSync(unitFile, { force: true });
    }
    systemctlUser(["daemon-reload"]);
  };

  try {
    for (const productionUnit of productionUnits) {
      const uniqueUnit = uniqueUnitName(fixture, productionUnit);
      const unitFile = join(unitDir, uniqueUnit);
      if (existsSync(unitFile)) {
        throw new Error(`refusing to start real-systemd UAT unit: unit file already exists: ${unitFile}`);
      }
      const loadState = systemctlUser(["show", uniqueUnit, "-p", "LoadState", "--value"]).stdout.trim();
      if (loadState && loadState !== "not-found") {
        throw new Error(`refusing to start real-systemd UAT unit: ${uniqueUnit} is already loaded (LoadState=${loadState})`);
      }
      executable(unitFile, unitFileContent(fixture, productionUnit));
      created.push({ productionUnit, uniqueUnit, unitFile });
    }
    systemctlUser(["daemon-reload"]);
    for (const { uniqueUnit } of created) {
      execFileSync("systemctl", ["--user", "start", uniqueUnit], { env: userEnv });
    }
    for (const { uniqueUnit } of created) {
      const deadline = Date.now() + 5_000;
      while (systemctlUser(["show", uniqueUnit, "-p", "ActiveState", "--value"]).stdout.trim() !== "active") {
        if (Date.now() >= deadline) throw new Error(`real systemd fixture for ${uniqueUnit} did not become active`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch (error) {
    teardownCreated();
    throw error;
  }

  return teardownCreated;
}

/** Restarts every unit for real, clearing failed state first — the same
 * two-step sequence rollout-agent-bridge.sh itself performs before start.
 */
function restartRealUnits(fixture: Fixture, productionUnits: string[]): void {
  for (const productionUnit of productionUnits) {
    const uniqueUnit = uniqueUnitName(fixture, productionUnit);
    systemctlUser(["reset-failed", uniqueUnit]);
    execFileSync("systemctl", ["--user", "start", uniqueUnit], { env: userEnv });
  }
}

function isActive(fixture: Fixture, productionUnit: string): boolean {
  return systemctlUser(["is-active", "--quiet", uniqueUnitName(fixture, productionUnit)]).status === 0;
}

/** §9 recovery step: a real `git reset --hard` to the fixture's previous
 * commit (never a detached checkout — must stay on branch `main`, which
 * git_check requires), then a real restart of every unit, then proof —
 * via observedHead, not just `git rev-parse HEAD` — that the restarted
 * processes actually observed the reverted code before returning.
 */
function revertToPreviousAndRestart(fixture: Fixture): void {
  execFileSync("git", ["-C", fixture.project, "reset", "--hard", fixture.previousCommit]);
  const head = execFileSync("git", ["-C", fixture.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(head, "working tree must be genuinely reverted to the previous commit before any restart").toBe(fixture.previousCommit);
  restartRealUnits(fixture, units);
  for (const unit of units) {
    expect(isActive(fixture, unit), `${unit} must be restarted after the revert`).toBe(true);
    expect(observedHead(fixture, unit), `${unit} must have observed the previous commit at its own startup, not just the working tree`).toBe(fixture.previousCommit);
  }
}

/** Before a fresh rollout attempt: real `git reset --hard` back to the
 * fixture's target commit (git_check requires HEAD === expectedCommit on
 * a clean tree) — the previous-pairing services stay running throughout;
 * the rollout invocation itself performs its own real stop.
 */
function advanceToTargetCommit(fixture: Fixture): void {
  execFileSync("git", ["-C", fixture.project, "reset", "--hard", fixture.expectedCommit]);
  const head = execFileSync("git", ["-C", fixture.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(head).toBe(fixture.expectedCommit);
}

describe.runIf(REAL_SYSTEMD)("Phase 4C.5 UAT — real systemd, non-production fixture environment (issue #135)", () => {
  let releaseSystemdLock: () => void;
  beforeEach(async () => {
    releaseSystemdLock = await acquireRealSystemdLock();
  });
  afterEach(() => releaseSystemdLock());

  it(
    "runs a full successful rollout across all active units and role-specific legacy fixtures",
    async () => {
      const fixture = createFixture();
      seedRoleFixtures(fixture);
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const before = fixture.dbPaths.map(sha256);
        const result = runRollout(fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
        for (const unit of units) expect(isActive(fixture, unit), unit).toBe(true);
        const artifacts = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        expect(readFileSync(join(artifacts, "rollout.log"), "utf8")).toContain("rollout completed");
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel must be gone after DONE").toBe(false);

        // Each role-specific legacy shape actually migrated and validated —
        // not just identical minimal databases changing bytes.
        for (const path of fixture.dbPaths) {
          const db = new Database(path, { readonly: true });
          try {
            expect(db.pragma("user_version", { simple: true }), path).toBeGreaterThan(0);
            expect(db.pragma("integrity_check", { simple: true }), path).toBe("ok");
            expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").get(), path).toBeTruthy();
          } finally {
            db.close();
          }
        }
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "STOPPED_UNCHANGED full rollback drill: real stop-then-backup failure, real code revert with observed-head proof, real restart, then a fresh rollout at the target commit succeeds",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const before = fixture.dbPaths.map(sha256);
        const failed = runRollout(fixture, "backup");
        const output = `${failed.stdout}\n${failed.stderr}`;
        expect(failed.status).not.toBe(0);
        expect(output).toMatch(/STATE: STOPPED_UNCHANGED/);
        expect(fixture.dbPaths.map(sha256)).toEqual(before);
        for (const unit of units) expect(isActive(fixture, unit), `${unit} must be genuinely stopped`).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained").toBe(true);

        // A bare re-invocation must not be able to proceed: blocked by the
        // sentinel first, and assert_service_active would reject it even
        // if it weren't.
        const bareRetry = runRollout(fixture);
        expect(bareRetry.status).not.toBe(0);
        expect(`${bareRetry.stdout}\n${bareRetry.stderr}`).toMatch(/interrupted rollout sentinel already exists/i);
        for (const unit of units) expect(isActive(fixture, unit)).toBe(false);

        // §9 recovery flow: clear the sentinel, genuinely revert code to
        // the previous commit (proven at the restarted process, not just
        // the working tree), restart for real, confirm active — then
        // return to the target commit and a fresh rollout succeeds.
        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        revertToPreviousAndRestart(fixture);

        advanceToTargetCommit(fixture);
        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "FAILED_RESTORED full rollback drill: real migrate-phase failure, automatic whole-cohort restore verified byte-identical, real revert-and-restart with observed-head proof, then a fresh rollout at the target commit succeeds",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const before = fixture.dbPaths.map(metadata);
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            FAKE_FAIL_PHASE: "migrate",
            FAKE_CORRUPT_DB: fixture.dbPaths[0],
          },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/STATE: FAILED_RESTORED/);
        expect(fixture.dbPaths.map(metadata)).toEqual(before);
        for (const unit of units) expect(isActive(fixture, unit), `${unit} must remain stopped — FAILED_RESTORED never auto-restarts`).toBe(false);
        // Code is still checked out at the target commit at the moment of
        // failure — the helper never reverts it; that is always a
        // separate manual step, completed below.
        expect(execFileSync("git", ["-C", fixture.project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(fixture.expectedCommit);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel removed once restoration is verified").toBe(false);

        // FAILED_RESTORED's sentinel is already gone (removal only means
        // "safe to hand to this documented recovery flow," never "safe to
        // bare-retry" — services remain stopped and code is still the
        // target commit until this drill completes the restart boundary).
        revertToPreviousAndRestart(fixture);

        advanceToTargetCommit(fixture);
        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before.map((m) => m.sha256));
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "RESTORE_INCOMPLETE full rollback drill: real migrate-phase failure where the automatic restore itself fails, manual per-database operator restoration until every SHA-256 matches, real revert-and-restart, then a fresh rollout succeeds",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const before = fixture.dbPaths.map(sha256);
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
        for (const unit of units) expect(isActive(fixture, unit)).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained — restoration unverified").toBe(true);

        // State is deliberately unknown/mixed here — this must never be
        // treated as "restored" until an operator manually confirms and
        // corrects it, database by database, using the exact same
        // rollout-restore.py mechanics the automatic path uses.
        const artifactDir = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const manifestRows = readFileSync(join(artifactDir, "backup-manifest.tsv"), "utf8")
          .trim().split("\n").slice(1)
          .map((line) => line.split("\t"));
        expect(manifestRows).toHaveLength(fixture.dbPaths.length);
        for (const [, source, backup] of manifestRows) {
          const restore = runRestore(source, backup);
          expect(restore.status, `${source}: ${restore.stdout}\n${restore.stderr}`).toBe(0);
          rmSync(`${source}-wal`, { force: true });
          rmSync(`${source}-shm`, { force: true });
        }
        for (const [, source, backup] of manifestRows) {
          expect(sha256(source), `${source} must match its manifest backup after manual restoration`).toBe(sha256(backup));
        }
        expect(fixture.dbPaths.map(sha256)).toEqual(before);

        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        revertToPreviousAndRestart(fixture);

        advanceToTargetCommit(fixture);
        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "STOPPED_PRESERVED full rollback drill: real post-start failure, database stays on the NEW schema with no automatic restore, explicit operator-approved restore, real revert-and-restart, then a fresh rollout succeeds",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const before = fixture.dbPaths.map(sha256);

        // Real start (all seven units genuinely come up); the failure is
        // injected only at the post-start journal smoke check, so this is
        // a genuine "new code + new schema, briefly running" scenario —
        // the one state in the whole machine where that pairing is live.
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root, FAKE_FAIL_PHASE: "smoke" },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/STATE: STOPPED_PRESERVED/);
        for (const unit of units) expect(isActive(fixture, unit), `${unit} must be stopped again after the post-start failure`).toBe(false);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained — always requires operator review").toBe(true);

        const afterFailure = fixture.dbPaths.map(sha256);
        expect(afterFailure, "databases must be genuinely migrated, not reverted").not.toEqual(before);

        const artifactDir = readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
        const manifestRows = readFileSync(join(artifactDir, "backup-manifest.tsv"), "utf8")
          .trim().split("\n").slice(1)
          .map((line) => line.split("\t"));
        expect(manifestRows).toHaveLength(fixture.dbPaths.length);
        for (const [, source, backup] of manifestRows) {
          expect(sha256(source), `${source} must still be on the new (migrated) schema, not equal to its pre-migration backup`).not.toBe(sha256(backup));
        }

        // Explicit operator-approved restore: the same rollout-restore.py
        // mechanics the automatic FAILED_RESTORED path uses, but invoked
        // manually per database — this state never triggers it itself.
        for (const [, source, backup] of manifestRows) {
          const restore = runRestore(source, backup);
          expect(restore.status, `${source}: ${restore.stdout}\n${restore.stderr}`).toBe(0);
          rmSync(`${source}-wal`, { force: true });
          rmSync(`${source}-shm`, { force: true });
        }
        expect(fixture.dbPaths.map(sha256), "every database must match its pre-migration state after the operator-approved restore").toEqual(before);

        const sentinelContent = readFileSync(join(fixture.logDir, ".rollout-in-progress"), "utf8");
        const recordedArtifactDir = /^artifact_dir=(.*)$/m.exec(sentinelContent)?.[1]!;
        const clear = spawnSync("bash", [sentinelClearPath, "--expected-commit", fixture.expectedCommit, "--artifact-dir", recordedArtifactDir], {
          encoding: "utf8",
          env: { ...process.env, AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root },
        });
        expect(clear.status, `${clear.stdout}\n${clear.stderr}`).toBe(0);

        // Real revert to previous code, proven at the restarted process
        // itself, before restarting — the exact boundary this drill exists
        // to prove.
        revertToPreviousAndRestart(fixture);

        advanceToTargetCommit(fixture);
        const retry = runRollout(fixture);
        expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
        expect(fixture.dbPaths.map(sha256)).not.toEqual(before);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "a real systemd containment failure where containment cannot be re-proven — the on_exit trap's re-verification itself fails, via an injected evidence read, not a damaged real cgroup filesystem",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      try {
        const result = spawnSync("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            FAKE_FAIL_PHASE: "backup",
            // Real systemctl stop/start still runs for every unit — only
            // the ControlGroup evidence read is spoofed, pointing at a
            // path that can never exist, so containment can genuinely
            // never be re-proven regardless of what real systemd reports
            // for ActiveState/SubState.
            FAKE_REAL_CONTROLGROUP_OVERRIDE: "/agent-bridge-uat-nonexistent-cgroup/does-not-exist",
          },
        });
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status).not.toBe(0);
        expect(output).toMatch(/containment could not be re-proven/i);
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel retained — the stopped state is genuinely uncertain").toBe(true);
      } finally {
        teardown();
      }
    },
    30_000,
  );

  it(
    "a genuinely concurrent rollout invocation is refused by the real lock before it can ever observe a retained prior sentinel — proving lock-then-sentinel ordering under real concurrency",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      let holder: ChildProcess | undefined;
      try {
        // Leave a real sentinel behind from an earlier failed run.
        const firstFailed = runRollout(fixture, "backup");
        expect(firstFailed.status).not.toBe(0);
        const sentinelPath = join(fixture.logDir, ".rollout-in-progress");
        expect(existsSync(sentinelPath)).toBe(true);
        restartRealUnits(fixture, units);
        for (const unit of units) expect(isActive(fixture, unit)).toBe(true);

        // A separate real process holds the exclusive rollout lock —
        // the same file rollout-agent-bridge.sh itself locks.
        holder = spawn("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive 9; sleep 3`]);
        const lockDeadline = Date.now() + 2_000;
        let locked = false;
        while (Date.now() < lockDeadline) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status !== 0) { locked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(locked, "lock holder never acquired the lock").toBe(true);

        // While the lock is held, a real second invocation must be
        // refused by the LOCK — it must never even reach, let alone
        // mention, the pre-existing sentinel.
        const blockedByLock = runRollout(fixture);
        expect(blockedByLock.status).not.toBe(0);
        const blockedByLockOutput = `${blockedByLock.stdout}\n${blockedByLock.stderr}`;
        expect(blockedByLockOutput).toMatch(/another rollout is already active/i);
        expect(blockedByLockOutput).not.toMatch(/interrupted rollout sentinel/i);

        holder.kill();
        await new Promise<void>((resolve) => holder!.once("close", () => resolve()));
        holder = undefined;

        // Once the lock is free, a fresh real invocation immediately hits
        // the retained sentinel — the specified lock-then-sentinel order.
        const blockedBySentinel = runRollout(fixture);
        expect(blockedBySentinel.status).not.toBe(0);
        expect(`${blockedBySentinel.stdout}\n${blockedBySentinel.stderr}`).toMatch(/interrupted rollout sentinel already exists/i);
      } finally {
        holder?.kill();
        teardown();
      }
    },
    30_000,
  );

  it(
    "a real SIGKILL delivered at a deterministic mid-cohort migration barrier leaves the sentinel retained, services stopped, the lock released, and a bare retry hard-blocked",
    async () => {
      const fixture = createFixture();
      useRealSystemctl(fixture);
      const teardown = await startRealUnits(fixture, units);
      let child: ChildProcess | undefined;
      const barrierFile = join(fixture.root, "migrate-barrier");
      try {
        // detached: true makes this bash process a process-group leader,
        // so killing the whole group (not just this one PID) below reaches
        // any grandchild (the runuser shim's real tsx/node migration
        // child) too.
        child = spawn("bash", [helperPath, "--expected-commit", fixture.expectedCommit], {
          env: {
            ...process.env,
            AGENT_BRIDGE_ROLLOUT_TEST_ROOT: fixture.root,
            // Deterministic mid-cohort barrier (Phase 4C.5): the real
            // migration child pauses after genuinely migrating the first
            // database and before touching the second, writing its
            // progress to barrierFile on every completed database. No
            // guessing from log timing — the assertions below poll this
            // file directly.
            AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE: barrierFile,
            AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX: "1",
          },
          stdio: "ignore",
          detached: true,
        });

        const barrierDeadline = Date.now() + 10_000;
        while (!existsSync(barrierFile) || readFileSync(barrierFile, "utf8").trim() !== "1") {
          if (Date.now() >= barrierDeadline) throw new Error("migration never reached the barrier (after database 1) in time");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // Proof the process is still alive and genuinely paused mid-cohort
        // — not that it happened to finish everything before we noticed.
        expect(child.exitCode, "the rollout process must still be running, paused at the barrier, not already finished").toBeNull();
        expect(existsSync(`${barrierFile}.resume`), "the barrier must not have been released yet").toBe(false);

        const pid = child.pid!;
        process.kill(-pid, "SIGKILL");
        await new Promise<void>((resolve) => child!.once("close", () => resolve()));
        child = undefined;

        // Belt-and-braces: wait until the lock file is genuinely
        // acquirable again before asserting on the retry's specific
        // failure message, so this test's own timing can never flake on
        // "how long a killed process group takes to fully disappear."
        const lockDeadline = Date.now() + 5_000;
        for (;;) {
          const probe = spawnSync("bash", ["-c", `exec 9>"${fixture.lockFile}"; flock --exclusive --nonblock 9 && flock --unlock 9`]);
          if (probe.status === 0) break;
          if (Date.now() >= lockDeadline) throw new Error("lock file never became acquirable after the kill — an orphaned process may still hold it");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        // A killed process cannot run its own EXIT trap — the sentinel is
        // exactly what makes this interruption visible and unrecoverable
        // by accident, instead of silently vanishing.
        expect(existsSync(join(fixture.logDir, ".rollout-in-progress")), "sentinel must survive a SIGKILL — nothing ran to remove it").toBe(true);
        for (const unit of units) expect(isActive(fixture, unit), `${unit} must still be stopped after the kill`).toBe(false);

        // Deliberately no assertion about final database content here
        // beyond the barrier proof already established: database 1 was
        // migrated, the cohort as a whole was not — that is exactly why
        // the sentinel forces a hard stop for manual review rather than
        // an automatic retry.
        const bareRetry = runRollout(fixture);
        expect(bareRetry.status).not.toBe(0);
        expect(`${bareRetry.stdout}\n${bareRetry.stderr}`).toMatch(/interrupted rollout sentinel already exists/i);
        for (const unit of units) expect(isActive(fixture, unit), `${unit} must still be stopped — the blocked retry never touched services`).toBe(false);
      } finally {
        if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
        teardown();
      }
    },
    30_000,
  );
});
