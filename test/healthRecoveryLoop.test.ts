import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import {
  applyAuthoritativeHealthObservation,
  getAutonomousGoal,
  runOwnerAuthorizedHealthRecovery,
  startOwnerAuthorizedHealthRecovery,
  healthRecoveryGoalId,
} from "../src/autonomousGoalRuntime.js";
import type { RunIngressEngine } from "../src/runIngress.js";
import { type as eventType } from "../src/events/types.js";

const paths: string[] = [];

function setup() {
  const path = join(tmpdir(), `health-recovery-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return openDb(path, { serviceId: "test-health-recovery", runId: `process-${Math.random()}` });
}

function engine(prompts: string[], result: unknown = { status: "complete", evidence: "provider says fixed" }): RunIngressEngine {
  return {
    executeSurfaceNeutralTurn: vi.fn().mockImplementation(async (input: any) => {
      prompts.push(input.prompt);
      input.collect(eventType.runCompleted({
        runId: input.runId,
        bot: "claude",
        chatId: input.chatKey,
        text: JSON.stringify(result),
        sessionId: null,
      }));
      return { text: JSON.stringify(result), sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
    }),
  } as RunIngressEngine;
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { rmSync(path); } catch { /* already removed */ }
  }
});

describe("owner-authorized health recovery loop", () => {
  it("does not create work from health evidence until the owner authorizes Investigate", () => {
    const db = setup();
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get()).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 0 });
    db.close();
  });

  it("starts one correlated ordinary Run and deduplicates replayed Investigate", async () => {
    const db = setup();
    const prompts: string[] = [];
    const first = await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("application-health-gap:workspace-1:app-1:1"),
      correlationId: "application-health-gap:workspace-1:app-1:1",
      objective: "Investigate the unhealthy application.",
      healthEvidence: "status=unhealthy; checked=2026-08-15T10:00:00Z",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 3,
    }, engine(prompts));
    const replay = await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("application-health-gap:workspace-1:app-1:1"),
      correlationId: "application-health-gap:workspace-1:app-1:1",
      objective: "same authorization replay",
      healthEvidence: "duplicate",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 3,
    }, engine(prompts));
    expect(first.runId).toBeTruthy();
    expect(replay.runId).toBe(first.runId);
    expect(prompts).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 1 });
    expect(prompts[0]).toContain("application-health-gap:workspace-1:app-1:1");
    db.close();
  });

  it("ignores provider self-report and completes only on later healthy evidence", async () => {
    const db = setup();
    const prompts: string[] = [];
    await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("gap-healthy"),
      correlationId: "gap-healthy",
      objective: "Investigate",
      healthEvidence: "unhealthy",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 3,
    }, engine(prompts, { status: "complete", evidence: "fixed" }));
    expect(getAutonomousGoal(db, healthRecoveryGoalId("gap-healthy")).status).toBe("active");
    expect(applyAuthoritativeHealthObservation(db, healthRecoveryGoalId("gap-healthy"), {
      status: "healthy", evidence: "authoritative check recovered", correlationId: "gap-healthy", observedAt: "2026-08-15T10:01:00Z",
    })).toBe("complete");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND status = 'received'").get()).toEqual({ count: 0 });
    db.close();
  });

  it("creates one bounded successor wake for persistent unhealthy evidence and carries prior outcomes", async () => {
    const db = setup();
    const prompts: string[] = [];
    await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("gap-persistent"),
      correlationId: "gap-persistent",
      objective: "Investigate",
      healthEvidence: "initial unhealthy",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 3,
    }, engine(prompts));
    expect(applyAuthoritativeHealthObservation(db, healthRecoveryGoalId("gap-persistent"), {
      status: "unhealthy", evidence: "still unhealthy", correlationId: "gap-persistent", observedAt: "2026-08-15T10:01:00Z",
    })).toBe("active");
    expect(applyAuthoritativeHealthObservation(db, healthRecoveryGoalId("gap-persistent"), {
      status: "unhealthy", evidence: "duplicate still unhealthy", correlationId: "gap-persistent", observedAt: "2026-08-15T10:01:00Z",
    })).toBe("active");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND status = 'received'").get()).toEqual({ count: 1 });
    await runOwnerAuthorizedHealthRecovery(db, healthRecoveryGoalId("gap-persistent"), engine(prompts));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("provider says fixed");
    expect(prompts[1]).toContain("still unhealthy");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get(`autonomous:${healthRecoveryGoalId("gap-persistent")}`)).toEqual({ count: 2 });
    db.close();
  });

  it("survives restart without duplicating the successor and stops at the existing cycle budget", async () => {
    const db = setup();
    await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("gap-budget"),
      correlationId: "gap-budget",
      objective: "Investigate",
      healthEvidence: "initial unhealthy",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 2,
    }, engine([]));
    applyAuthoritativeHealthObservation(db, healthRecoveryGoalId("gap-budget"), { status: "unhealthy", evidence: "still unhealthy", correlationId: "gap-budget", observedAt: "2026-08-15T10:01:00Z" });
    db.close();
    const reopened = openDb(paths.at(-1)!, { serviceId: "test-health-recovery", runId: "restarted" });
    const prompts: string[] = [];
    await runOwnerAuthorizedHealthRecovery(reopened, healthRecoveryGoalId("gap-budget"), engine(prompts));
    expect(prompts).toHaveLength(1);
    expect(applyAuthoritativeHealthObservation(reopened, healthRecoveryGoalId("gap-budget"), { status: "unhealthy", evidence: "still unhealthy again", correlationId: "gap-budget", observedAt: "2026-08-15T10:02:00Z" })).toBe("budget_exhausted");
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND status = 'received'").get()).toEqual({ count: 0 });
    reopened.close();
  });

  it("does not revive a cancelled recovery when a late observation arrives", async () => {
    const db = setup();
    const prompts: string[] = [];
    await startOwnerAuthorizedHealthRecovery(db, {
      ownerAction: "investigate",
      goalId: healthRecoveryGoalId("gap-cancelled"),
      correlationId: "gap-cancelled",
      objective: "Investigate",
      healthEvidence: "initial unhealthy",
      constraints: ["inspect only"],
      bot: "claude",
      maxCycles: 3,
    }, engine(prompts));
    const run = db.raw.prepare("SELECT run_id FROM bridge_runs WHERE chat_id = ?").get(`autonomous:${healthRecoveryGoalId("gap-cancelled")}`) as { run_id: string };
    db.raw.prepare("UPDATE bridge_runs SET status = 'cancelled', error = 'owner cancelled', ended_at = CURRENT_TIMESTAMP WHERE run_id = ?").run(run.run_id);
    expect(applyAuthoritativeHealthObservation(db, healthRecoveryGoalId("gap-cancelled"), { status: "unhealthy", evidence: "late unhealthy", correlationId: "gap-cancelled", observedAt: "2026-08-15T10:01:00Z" })).toBe("cancelled");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND status = 'received'").get()).toEqual({ count: 0 });
    db.close();
  });
});
