import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  actions,
  cleanupRoots,
  createFixture,
  type Fixture,
  helperPath,
  prepareImmutableRelease,
  runRollout,
  sentinelClearPath,
  sha256,
  units,
  useMinimalInventory,
} from "./support/rolloutFixture.js";

afterEach(cleanupRoots);

describe("interrupted-rollout sentinel (Phase 4C.4, issue #135)", { timeout: 30_000 }, () => {
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
