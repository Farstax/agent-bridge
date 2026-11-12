import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { IDLE_UPGRADE_FENCE_KEY, readIdleUpgradeState, tryAdmitIdleUpgrade, releaseIdleUpgrade } from "../src/idleUpgradeAdmission.js";
import {
  actions, cleanupRoots, createFixture, prepareImmutableRelease, runRollout, units, type Fixture,
} from "./support/rolloutFixture";

afterEach(cleanupRoots);

const identity = { surfaceIdentity: "acp:outward", chatKey: "desk-run" };
const realIdle = { FAKE_REAL_IDLE: "1" };

/** Current-schema databases are the only shape the real idle admission can prove. */
function useCurrentSchemaDatabases(fixture: Fixture): void {
  for (const path of fixture.dbPaths) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    openDb(path).close();
  }
}

function startOutwardRun(path: string): void {
  const db = openDb(path);
  db.insertRun("desk-run", identity, "claude");
  db.acquireLock(identity.surfaceIdentity, identity.chatKey);
  db.close();
}

function finishOutwardRun(path: string): void {
  const db = openDb(path);
  db.raw.prepare("UPDATE bridge_runs SET status = 'completed'").run();
  db.raw.prepare("DELETE FROM execution_locks").run();
  db.close();
}

function fenceRows(fixture: Fixture, paths = fixture.dbPaths): number {
  // A successful rollout retires the legacy health database.
  return paths.filter((path) => existsSync(path)).filter((path) => {
    const db = new Database(path, { fileMustExist: true });
    try { return !!db.prepare("SELECT 1 FROM settings WHERE key = ?").get(IDLE_UPGRADE_FENCE_KEY); }
    finally { db.close(); }
  }).length;
}

describe("protected rollout idle-fence admission (#1207)", () => {
  it("defers before any service stop while an outward ACP Run is active, then proceeds once without duplication", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    startOutwardRun(fixture.dbPaths[3]);
    const { releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);

    const deferred = runRollout(fixture, undefined, undefined, realIdle);
    const output = `${deferred.stdout}\n${deferred.stderr}`;
    expect(deferred.status).not.toBe(0);
    expect(output).toMatch(/\bprovider_sessions_active\b/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units);
    expect(fenceRows(fixture)).toBe(0);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(false);

    finishOutwardRun(fixture.dbPaths[3]);
    const resumed = runRollout(fixture, undefined, undefined, realIdle);
    execFileSync("find", [releaseDir, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(resumed.status, `${resumed.stdout}\n${resumed.stderr}`).toBe(0);
    // One stop command for the whole cohort, issued only by the resumed rollout.
    expect(readFileSync(join(fixture.root, "stop-count"), "utf8").trim()).toBe("1");
    expect(fenceRows(fixture)).toBe(0);
    for (const path of fixture.dbPaths.filter(existsSync)) expect(readIdleUpgradeState(path)).toBe("idle");
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units.filter((unit) => unit !== "agent-bridge-health.service"));
  }, 60_000);

  it("fails closed without stopping a service when idle state is unknown", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    const db = new Database(fixture.dbPaths[0]);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(IDLE_UPGRADE_FENCE_KEY, "not-a-fence");
    db.close();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture, undefined, undefined, realIdle);
    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/idle_admission_unknown/);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/provider_sessions_active/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(true);
  }, 60_000);

  it("preserves recovery evidence when an unknown admission leaves a partial fence", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    const partial = tryAdmitIdleUpgrade(fixture.dbPaths[0]);
    expect(partial.state).toBe("admitted");
    if (partial.state !== "admitted") throw new Error("fixture did not acquire fence");
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const result = runRollout(fixture, undefined, undefined, { FAKE_IDLE_PARTIAL_UNKNOWN: "1" });
    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(actions(fixture)).not.toContain("systemctl:stop");
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(true);
    expect(readIdleUpgradeState(fixture.dbPaths[0])).toBe("deferred_busy");
    expect(releaseIdleUpgrade(fixture.dbPaths[0], partial.fence.token)).toBe(true);
    expect(readIdleUpgradeState(fixture.dbPaths[0])).toBe("idle");
  }, 60_000);

  it("refuses without a service stop when the target release does not ship the idle admission tool", () => {
    const fixture = createFixture();
    rmSync(join(fixture.project, "scripts", "idle-maintenance.ts"));
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);
    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/idle_admission_unknown: the target release does not ship/);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  }, 60_000);

  it("blocks new Bridge work through service restart and releases the fence after acceptance", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    const { releaseDir } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const probe = join(fixture.root, "probe.mjs");
    const probeResult = join(fixture.root, "probe-result");
    writeFileSync(probe, `import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
const db = new Database(${JSON.stringify(fixture.dbPaths[3])});
try {
  db.prepare("INSERT INTO execution_locks (surface, chat_key, service_id, run_id, acquisition_id, lease_expires_at) VALUES ('acp:outward','racer','svc','racer','acq','2099-01-01T00:00:00Z')").run();
  writeFileSync(${JSON.stringify(probeResult)}, "admitted");
} catch (error) { writeFileSync(${JSON.stringify(probeResult)}, String(error.message)); }
`);
    const hook = join(fixture.root, "on-first-stop");
    writeFileSync(hook, `#!/usr/bin/env bash\ncd ${JSON.stringify(process.cwd())} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(probe)}\n`);
    chmodSync(hook, 0o755);
    const startHook = join(fixture.root, "on-service-start");
    const stopResult = join(fixture.root, "stop-probe-result");
    writeFileSync(startHook, `#!/usr/bin/env bash\ncp ${JSON.stringify(probeResult)} ${JSON.stringify(stopResult)}\nexec ${JSON.stringify(hook)}\n`);
    chmodSync(startHook, 0o755);

    const result = runRollout(fixture, undefined, undefined, { ...realIdle, FAKE_ON_FIRST_STOP: hook, FAKE_ON_SERVICE_START: startHook });
    execFileSync("find", [releaseDir, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(stopResult, "utf8")).toContain("agent_bridge_idle_maintenance_deferred_busy");
    expect(readFileSync(probeResult, "utf8")).toContain("agent_bridge_idle_maintenance_deferred_busy");
    expect(fenceRows(fixture)).toBe(0);
  }, 60_000);

  it("keeps the fence through backup failure and releases it only after recovery restores the previous release", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture, "migrate", undefined, realIdle);
    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(/FAILED_RESTORED/);
    expect(readlinkSync(currentPointer)).toBe(fixture.previousCommit);
    expect(fenceRows(fixture)).toBe(0);
    for (const path of fixture.dbPaths) expect(readIdleUpgradeState(path)).toBe("idle");
    expect(readFileSync(fixture.stateFile, "utf8").trim().split("\n")).toEqual(units);
  }, 60_000);

  it("retains the fence and sentinel when containment cannot be re-proven after failure", () => {
    const fixture = createFixture();
    useCurrentSchemaDatabases(fixture);
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture, "migrate", "active", realIdle);
    execFileSync("find", [join(fixture.root, "releases"), "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(fixture.logDir, ".rollout-in-progress"))).toBe(true);
    // dbPaths[0] is deliberately corrupted by the failure injection.
    expect(fenceRows(fixture, fixture.dbPaths.slice(1))).toBeGreaterThan(0);
  }, 60_000);
});
