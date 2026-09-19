import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { RunRepository } from "../src/repositories/runRepository.js";
import { getBundledRolloutDb } from "./support/rolloutDbBundled.js";
import {
  actions,
  cleanupRoots,
  createFixture,
  prepareImmutableRelease,
  runRollout,
} from "./support/rolloutFixture.js";

const tempRoots: string[] = [];

afterEach(() => {
  cleanupRoots();
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

function oldTimestamp(): string {
  return "2026-08-01T00:00:00.000Z";
}

function recentTimestamp(): string {
  return new Date().toISOString();
}

describe("ACP telemetry retention", () => {
  it("prunes only old ACP events from terminal Runs and preserves active sequencing", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-retention-"));
    tempRoots.push(root);
    const dbPath = join(root, "bridge.sqlite");
    const db = openDb(dbPath);

    db.insertRun("terminal-old", "chat-1", "claude");
    db.insertEvent("terminal-old", 1, "acp.event", oldTimestamp(), { type: "acp.event", payload: "old" });
    db.insertEvent("terminal-old", 2, "run.started", oldTimestamp(), { type: "run.started" });
    expect(db.updateRunCompleted("terminal-old", "done", "session-1")).toBe(true);

    db.insertRun("terminal-recent", "chat-2", "claude");
    db.insertEvent("terminal-recent", 1, "acp.event", recentTimestamp(), { type: "acp.event", payload: "recent" });
    expect(db.updateRunCompleted("terminal-recent", "done", "session-2")).toBe(true);

    db.insertRun("running-old", "chat-3", "claude");
    db.insertEvent("running-old", 1, "acp.event", oldTimestamp(), { type: "acp.event", payload: "active" });

    db.insertRun("terminal-diagnostic", "chat-4", "claude");
    db.insertEvent("terminal-diagnostic", 1, "run.diagnostic", oldTimestamp(), { type: "run.diagnostic" });
    expect(db.updateRunFailed("terminal-diagnostic", "failed")).toBe(true);
    db.close();

    const tool = getBundledRolloutDb();
    const first = JSON.parse(execFileSync(process.execPath, [tool, "maintain", "--db", dbPath, "--evidence", "-"], { encoding: "utf8" }));
    expect(first.mode).toBe("maintain");
    expect(first.retentionDays).toBe(14);
    expect(first.databases[0]).toMatchObject({
      path: dbPath,
      deletedAcpEvents: 1,
      integrity: "ok",
      vacuumed: false,
    });
    expect(first.databases[0].before.pageCount).toBeGreaterThan(0);
    expect(first.databases[0].afterDelete.freePages).toBeGreaterThanOrEqual(0);

    const after = openDb(dbPath);
    expect(after.getEventsForRun("terminal-old").map((row) => row.type)).toEqual(["run.started"]);
    expect(after.getEventsForRun("terminal-recent").map((row) => row.type)).toEqual(["acp.event"]);
    expect(after.getEventsForRun("running-old").map((row) => row.type)).toEqual(["acp.event"]);
    expect(after.getEventsForRun("terminal-diagnostic").map((row) => row.type)).toEqual(["run.diagnostic"]);

    const reconciled = new RunRepository(after.raw).reconcileOrphanedRun("running-old", new Date().toISOString(), {
      reason: "test-reconcile",
      reconciledAt: new Date().toISOString(),
      processState: "absent",
      lockState: "absent",
      cutoffMs: Date.now(),
    });
    expect(reconciled).toBe(true);
    expect(after.getEventsForRun("running-old").map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    after.close();

    const second = JSON.parse(execFileSync(process.execPath, [tool, "maintain", "--db", dbPath, "--evidence", "-"], { encoding: "utf8" }));
    expect(second.databases[0].deletedAcpEvents).toBe(0);
  });

  it("is invoked by guarded rollout after service containment and before restart", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const log = actions(fixture);
    const stopIndex = log.indexOf("systemctl:stop");
    const maintainIndex = log.indexOf(" maintain ");
    const startIndex = log.lastIndexOf("systemctl:start");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(maintainIndex).toBeGreaterThan(stopIndex);
    expect(startIndex).toBeGreaterThan(maintainIndex);
    expect(readFileSync(fixture.stateFile, "utf8")).toContain("agent-bridge-interactive.service");
  }, 20_000);

  it("restores the pre-rollout database if maintenance itself fails", () => {
    const fixture = createFixture();
    const { currentPointer } = prepareImmutableRelease(fixture, fixture.previousCommit);
    const before = readFileSync(fixture.dbPaths[0]);

    const result = runRollout(fixture, "maintain");
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/FAILED_RESTORED|PRE_BACKUP_RECOVERED/);
    expect(readFileSync(fixture.dbPaths[0])).toEqual(before);
    expect(readFileSync(currentPointer, "utf8")).toBeDefined();
  }, 20_000);
});
