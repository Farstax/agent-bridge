import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { tryAdmitIdleUpgrade, releaseIdleUpgrade } from "../src/idleUpgradeAdmission.js";
import { persistProviderSession } from "../src/providers/sessionRuntime.js";
import {
  buildDiscordRunContinuationTurn,
  buildTelegramRunContinuationTurn,
  cancelPendingRunContinuation,
  cancelPendingRunContinuationsForChat,
  claimDueRunContinuation,
  acceptedRecoveryTurn,
  rolloutRecoveryProviderAuthority,
  buildRunContinuationInstruction,
  OUTWARD_RUN_ACCEPTED_TURN_PREFIX,
  listRunContinuations,
  requestRunContinuation,
  scanRunContinuations,
} from "../src/runContinuation.js";
import * as runOwnedProcesses from "../src/runOwnedProcesses.js";

const paths: string[] = [];

function setup(databaseRole?: "interactive") {
  const path = join(tmpdir(), `rollout-continuation-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  const db = openDb(path, { serviceId: "rollout-continuation-test", runId: "test-process", ...(databaseRole ? { databaseRole } : {}) });
  return { db, path };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of paths.splice(0)) {
    try {
      rmSync(path);
    } catch {
      /* already removed */
    }
  }
});

describe("controlled self-rollout continuation recovery (issue #964)", () => {
  it("preserves continuation across controlled rollout and dispatches post-rollout verification", async () => {
    const { db, path } = setup();
    const runId = "rollout-run-1";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "Deploy of release-2026.10.10-1 was started; verifying health after service restart",
      afterSeconds: 10,
    }, 1_000);

    const contBefore = listRunContinuations(db)[0];
    expect(contBefore.state).toBe("pending");
    expect(contBefore.rolloutProvenance).toBeUndefined();

    // Step 10 of guarded rollout: reconcileControlledRollout
    const reconResult = db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });
    expect(reconResult.reconciledRunIds).toContain(runId);

    // Reconciliation cannot stamp a continuation during the all-role fence.
    // The existing worker claims the completed audit only after fence release.
    const contAfter = listRunContinuations(db)[0];
    expect(contAfter.rolloutProvenance).toBeUndefined();

    // Service restarts - simulate new service instance
    db.close();
    const restartedDb = openDb(path, { serviceId: "agent-bridge-new-service", runId: "new-proc" });

    // Before dueAt (dueAt = 11_000)
    expect(claimDueRunContinuation(restartedDb, runId, 10_999)).toBeNull();

    // When due
    const dispatch = vi.fn(async (claimed) => {
      const turn = buildTelegramRunContinuationTurn(claimed, "actor-1");
      expect(turn.text).toContain("Deploy of release-2026.10.10-1 was started");
      expect(turn.text).toContain("[Agent Bridge post-rollout verification]");
      expect(turn.text).toContain("read-only verification of current service health");
      expect(turn.text).not.toContain("continue the original objective");
      expect(turn.executionMode).toBe("safe");
      expect(turn.verificationOnly).toBe(true);
      expect(turn.queueOnly).toBe(true);
    });

    await scanRunContinuations(restartedDb, surfaceIdentity, dispatch, 11_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const settled = listRunContinuations(restartedDb)[0];
    expect(settled.rolloutProvenance?.originRunId).toBe(runId);
    expect(settled.rolloutProvenance?.reason).toBe("interrupted_by_controlled_rollout");
    expect(settled.state).toBe("completed");

    restartedDb.close();
  });

  it("reconciles an existing continuation while the exact SQLite fence is held and only claims after release", () => {
    const { db, path } = setup();
    const runId = "fenced-rollout-recovery";
    db.insertRun(runId, { surfaceIdentity: "acp:outward", chatKey: "conversation-1" }, "codex");
    requestRunContinuation(db, {
      originRunId: runId, surfaceIdentity: "acp:outward",
      chatKey: "conversation-1", provider: "codex",
      reason: "inspect previous work before resuming", afterSeconds: 10,
      outwardSessionId: "workstream-1",
    }, 1_000);
    const admitted = tryAdmitIdleUpgrade(path, process.pid, { interruptActive: true });
    expect(admitted.state).toBe("admitted");
    if (admitted.state !== "admitted") throw new Error("expected fence");
    // The guarded trigger would reject the old reconciliation UPDATE settings.
    expect(() => db.raw.prepare("UPDATE settings SET value = value WHERE key = ?")
      .run("run-continuation:v1:" + runId)).toThrow("agent_bridge_idle_maintenance_deferred_busy");
    const result = db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout", nowMs: 2_000, isProcessAlive: () => false,
    });
    expect(result.reconciledRunIds).toEqual([runId]);
    expect(listRunContinuations(db)[0].rolloutProvenance).toBeUndefined();
    expect(claimDueRunContinuation(db, runId, 11_000)).toBeNull();
    expect(releaseIdleUpgrade(path, admitted.fence.token)).toBe(true);
    // Legacy/manual ACP Runs without the exact accepted-turn link are not
    // recoverable merely because their timestamps look plausible.
    const claimed = claimDueRunContinuation(db, runId, 11_000, { isProcessAlive: () => false });
    expect(claimed).toBeNull();
    expect(listRunContinuations(db)[0].state).toBe("failed");
    expect(claimDueRunContinuation(db, runId, 11_000)).toBeNull();
    db.close();
  });

  it("arms exactly one accepted ordinary Workstream objective before a guarded restart and resumes inspection first", () => {
    const { db, path } = setup("interactive");
    const runId = "accepted-workstream-run-1";
    const conversation = "workstream-conversation-1";
    db.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
      .run("workstream-1", conversation, process.cwd());
    db.insertRun(runId, { surfaceIdentity: "acp:outward", chatKey: conversation }, "codex");
    const originalId = db.addConvTurn(conversation, "user", "Implement the pending change safely", "codex",
      { surfaceIdentity: "acp:outward" });
    db.setSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + runId, String(originalId));
    const admitted = tryAdmitIdleUpgrade(path, process.pid, { interruptActive: true });
    expect(admitted.state).toBe("admitted");
    if (admitted.state !== "admitted") throw new Error("expected guarded rollout");
    const candidate = listRunContinuations(db, "acp:outward")[0];
    expect(candidate).toMatchObject({
      id: runId, originRunId: runId, rolloutRecoveryOnly: true,
      recoveryOriginalTurnId: originalId, outwardSessionId: "workstream-1",
      state: "pending",
    });
    expect(listRunContinuations(db, "acp:outward")).toHaveLength(1);
    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout", isProcessAlive: () => false,
    });
    expect(claimDueRunContinuation(db, runId, Date.now() + 15_000, {
      isProcessAlive: () => false,
    })).toBeNull();
    expect(releaseIdleUpgrade(path, admitted.fence.token)).toBe(true);
    const claimed = claimDueRunContinuation(db, runId, Date.now() + 15_000, {
      isProcessAlive: () => false, runId: "continuation-worker", claimToken: "exact-claim",
    });
    expect(claimed?.state).toBe("claimed");
    expect(claimed?.claimToken).toBe("exact-claim");
    expect(claimed?.rolloutProvenance?.originRunId).toBe(runId);
    expect(acceptedRecoveryTurn(db, claimed!)).toMatchObject({ id: originalId });
    expect(rolloutRecoveryProviderAuthority(db, claimed!)).toEqual({ rolloutRecovery: true });
    expect(buildRunContinuationInstruction(claimed!)).toContain("Before acting, inspect");
    expect(buildRunContinuationInstruction(claimed!)).toContain("Do not replay");
    expect(claimDueRunContinuation(db, runId, Date.now() + 16_000)).toBeNull();
    db.close();
  });

  it("does not wake a normally completed or user-cancelled accepted objective", () => {
    const { db, path } = setup("interactive");
    const conversation = "completed-workstream";
    db.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
      .run("completed-workstream-session", conversation, process.cwd());
    db.insertRun("normally-completed-run", { surfaceIdentity: "acp:outward", chatKey: conversation }, "codex");
    const original = db.addConvTurn(conversation, "user", "Do a task", "codex", { surfaceIdentity: "acp:outward" });
    db.setSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + "normally-completed-run", String(original));
    const fence = tryAdmitIdleUpgrade(path, process.pid, { interruptActive: true });
    expect(fence.state).toBe("admitted");
    if (fence.state !== "admitted") throw new Error("fence unavailable");
    expect(releaseIdleUpgrade(path, fence.fence.token)).toBe(true);
    expect(db.updateRunCompleted("normally-completed-run", "Done", null)).toBe(true);
    expect(claimDueRunContinuation(db, "normally-completed-run", Date.now() + 15_000)).toBeNull();
    expect(listRunContinuations(db)[0].state).toBe("cancelled");
    db.close();
  });

  it("reuses the only pending agent wake and never arms an ambiguous accepted user turn", () => {
    const { db, path } = setup("interactive");
    const workstream = "two-input-workstream";
    db.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
      .run("two-input-session", workstream, process.cwd());
    db.insertRun("existing-wake-run", { surfaceIdentity: "acp:outward", chatKey: workstream }, "claude");
    const accepted = db.addConvTurn(workstream, "user", "Finish task", "claude", { surfaceIdentity: "acp:outward" });
    db.setSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + "existing-wake-run", String(accepted));
    const existing = requestRunContinuation(db, {
      originRunId: "existing-wake-run", surfaceIdentity: "acp:outward",
      chatKey: workstream, provider: "claude",
      reason: "Agent requested follow-up", afterSeconds: 30,
      outwardSessionId: "two-input-session",
    });
    const admitted = tryAdmitIdleUpgrade(path, process.pid, { interruptActive: true });
    expect(admitted.state).toBe("admitted");
    if (admitted.state !== "admitted") throw new Error("expected admission");
    const armed = listRunContinuations(db, "acp:outward");
    expect(armed).toHaveLength(1);
    expect(armed[0]).toMatchObject({
      id: existing.id, reason: existing.reason, dueAt: existing.dueAt,
    });
    expect(armed[0].rolloutRecoveryOnly).toBeUndefined();
    expect(armed[0].recoveryOriginalTurnId).toBeUndefined();
    expect(releaseIdleUpgrade(path, admitted.fence.token)).toBe(true);
    // Without actual interruption, the agent's original wake remains intact.
    expect(db.updateRunCompleted("existing-wake-run", "done", null)).toBe(true);
    expect(claimDueRunContinuation(db, "existing-wake-run", Date.now() + 40_000)).toBeNull();
    expect(listRunContinuations(db, "acp:outward")[0].rolloutRecoveryOnly).toBeUndefined();

    db.insertRun("ambiguous-run", { surfaceIdentity: "acp:outward", chatKey: "other" }, "codex");
    db.raw.prepare("INSERT INTO outward_acp_sessions (session_id, conversation_id, cwd) VALUES (?, ?, ?)")
      .run("other-session", "other", process.cwd());
    const first = db.addConvTurn("other", "user", "First request", "codex", { surfaceIdentity: "acp:outward" });
    db.setSetting(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + "ambiguous-run", String(first));
    db.addConvTurn("other", "user", "Second request", "codex", { surfaceIdentity: "acp:outward" });
    const admitted2 = tryAdmitIdleUpgrade(path, process.pid, { interruptActive: true });
    expect(admitted2.state).toBe("admitted");
    if (admitted2.state !== "admitted") throw new Error("expected admission");
    expect(listRunContinuations(db, "acp:outward")).toHaveLength(1);
    expect(releaseIdleUpgrade(path, admitted2.fence.token)).toBe(true);
    db.close();
  });

  it("fails closed if restart occurs before trusted handoff / commit", async () => {
    const { db, path } = setup();
    const runId = "uncontrolled-crash-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    const t0 = Date.now();
    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "CI pending",
      afterSeconds: 10,
    }, t0);

    // Process crashed abruptly WITHOUT reconcileControlledRollout
    // Startup orphan reconciliation runs instead
    const reconcileNow = t0 + 2_000;
    await db.reconcileOrphanedRuns({
      reason: "stale_after_cutoff",
      minAgeMs: 0,
      nowMs: reconcileNow,
      containmentState: () => "proven",
      processState: () => "absent",
    });

    // Continuation should fail closed because originRun ended with failed and has no rollout provenance
    expect(claimDueRunContinuation(db, runId, t0 + 12_000)).toBeNull();
    const cont = listRunContinuations(db)[0];
    expect(cont.state).toBe("cancelled");
    expect(cont.error).toBe("originating Run ended with status failed");
    db.close();
  });

  it("prevents duplicate execution across repeated restarts and duplicate wake scans", async () => {
    const { db, path } = setup();
    const runId = "dedup-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "verification after restart",
      afterSeconds: 10,
    }, 1_000);

    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });

    const dispatch = vi.fn(async () => undefined);

    // First scan claims and completes
    await scanRunContinuations(db, surfaceIdentity, dispatch, 11_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Duplicate scan on same process
    await scanRunContinuations(db, surfaceIdentity, dispatch, 12_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Service restart
    db.close();
    const restartedDb = openDb(path, { serviceId: "service-restart-2", runId: "proc-2" });
    await scanRunContinuations(restartedDb, surfaceIdentity, dispatch, 13_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    restartedDb.close();
  });

  it("fails closed when provider process or descendant is still alive", () => {
    const { db } = setup();
    const runId = "alive-proc-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "verification after restart",
      afterSeconds: 10,
    }, 1_000);

    // If liveness check fails during rollout reconciliation, provenance is withheld
    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
      isProcessAlive: (id) => id === runId,
    });

    expect(listRunContinuations(db)[0].rolloutProvenance).toBeUndefined();

    // Even if provenance were somehow present, claimDueRunContinuation verifies liveness
    // Stamp provenance manually to verify the claim gate
    const cont = listRunContinuations(db)[0];
    const auditId = "audit-alive-test";
    db.raw.prepare(`INSERT INTO reconciliation_audit (id, kind, subject_id, status, reason, before_json, created_at)
      VALUES (?, 'run', ?, 'completed', 'interrupted_by_controlled_rollout', ?, ?)`
    ).run(auditId, runId, JSON.stringify({ containmentState: "proven", processState: "absent" }), new Date(2000).toISOString());

    cont.rolloutProvenance = {
      reconciledAt: new Date(2000).toISOString(),
      reason: "interrupted_by_controlled_rollout",
      reconciliationAuditId: auditId,
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify(cont),
      `run-continuation:v1:${runId}`,
    );

    // Attempting to claim while process is alive fails closed
    const claimResult = claimDueRunContinuation(db, runId, 12_000, {
      isProcessAlive: (id) => id === runId,
    });
    expect(claimResult).toBeNull();

    const cancelled = listRunContinuations(db)[0];
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("originating Run process or descendant is still active");

    db.close();
  });

  it("fails closed on user /stop or /reset", () => {
    const { db } = setup();
    const runId = "user-stop-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "verification after restart",
      afterSeconds: 10,
    }, 1_000);

    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });

    // User issues /stop
    const cancelledCount = cancelPendingRunContinuationsForChat(
      db,
      surfaceIdentity,
      chatKey,
      "originating Run cancelled by user",
      3_000,
    );
    expect(cancelledCount).toBe(1);

    const cont = listRunContinuations(db)[0];
    expect(cont.state).toBe("cancelled");
    expect(cont.error).toBe("originating Run cancelled by user");

    // Cannot be claimed
    expect(claimDueRunContinuation(db, runId, 12_000)).toBeNull();

    db.close();
  });

  it("fails closed if user /stop or /reset is queued in pending_messages", () => {
    const { db } = setup();
    const runId = "user-pending-reset-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "verification after restart",
      afterSeconds: 10,
    }, 1_000);

    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });

    // Queue a pending /reset message
    db.raw.prepare(`INSERT INTO pending_messages (surface, chat_key, chat_id, state, prompt, created_at)
      VALUES (?, ?, -1004366290625, 'queued', '/reset', ?)`
    ).run(surfaceIdentity, chatKey, new Date(3000).toISOString());

    expect(claimDueRunContinuation(db, runId, 12_000)).toBeNull();

    const cont = listRunContinuations(db)[0];
    expect(cont.state).toBe("cancelled");
    expect(cont.error).toBe("originating Run cancelled or reset by user");

    db.close();
  });

  it("fails closed on absent or malformed rollout provenance or unproven containment", () => {
    const { db } = setup();
    const runId = "tampered-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "verification after restart",
      afterSeconds: 10,
    }, 1_000);

    // Mark run failed with rollout reason
    db.raw.prepare("UPDATE bridge_runs SET status = 'failed', error = 'interrupted_by_controlled_rollout' WHERE run_id = ?").run(runId);

    // Case A: Missing audit row
    const cont = listRunContinuations(db)[0];
    cont.rolloutProvenance = {
      reconciledAt: new Date(2000).toISOString(),
      reason: "interrupted_by_controlled_rollout",
      reconciliationAuditId: "nonexistent-audit-id",
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify(cont),
      `run-continuation:v1:${runId}`,
    );

    expect(claimDueRunContinuation(db, runId, 12_000)).toBeNull();
    expect(listRunContinuations(db)[0].error).toBe("reconciliation audit evidence missing or invalid");

    // Case B: Audit record has unproven containment
    const auditId2 = "unproven-audit-id";
    db.raw.prepare(`INSERT INTO reconciliation_audit (id, kind, subject_id, status, reason, before_json, created_at)
      VALUES (?, 'run', ?, 'completed', 'interrupted_by_controlled_rollout', ?, ?)`
    ).run(auditId2, runId, JSON.stringify({ containmentState: "unproven", processState: "alive" }), new Date(2000).toISOString());

    const cont2 = listRunContinuations(db)[0];
    cont2.state = "pending";
    cont2.rolloutProvenance = {
      reconciledAt: new Date(2000).toISOString(),
      reason: "interrupted_by_controlled_rollout",
      reconciliationAuditId: auditId2,
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
    };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(
      JSON.stringify(cont2),
      `run-continuation:v1:${runId}`,
    );

    expect(claimDueRunContinuation(db, runId, 12_000)).toBeNull();
    expect(listRunContinuations(db)[0].error).toBe("reconciliation containment not proven");

    db.close();
  });

  it("admits verification-only continuation when origin run has no saved provider session", () => {
    const { db } = setup();
    const runId = "no-session-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    // Origin run has session_id = NULL in bridge_runs
    expect(db.getRun(runId).session_id).toBeNull();

    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "Post-deploy health check",
      afterSeconds: 10,
    }, 1_000);

    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });

    // Controlled rollout continuation succeeds even with NULL session_id
    const claimed = claimDueRunContinuation(db, runId, 12_000);
    expect(claimed).not.toBeNull();
    expect(claimed?.state).toBe("claimed");

    // But an ordinary run continuation WITHOUT rollout provenance fails if session_id is missing
    const ordinaryRunId = "ordinary-no-session";
    db.insertRun(ordinaryRunId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: ordinaryRunId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "ordinary check",
      afterSeconds: 10,
    }, 1_000);
    // Mark ordinary run done with null session
    db.raw.prepare("UPDATE bridge_runs SET status = 'done', session_id = NULL WHERE run_id = ?").run(ordinaryRunId);

    expect(claimDueRunContinuation(db, ordinaryRunId, 12_000)).toBeNull();
    expect(listRunContinuations(db).find((c) => c.id === ordinaryRunId)?.error).toBe(
      "originating Run has no resumable provider session",
    );

    db.close();
  });

  it("does not replay original ambiguous prompt/mutations in continuation turn", () => {
    const continuation = {
      version: 1 as const,
      id: "run-turn-test",
      originRunId: "run-turn-test",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-1004366290625:2",
      provider: "claude" as const,
      reason: "Verify systemd service status after self-restart",
      requestedAt: new Date(1000).toISOString(),
      dueAt: new Date(11000).toISOString(),
      expiresAt: new Date(7200000).toISOString(),
      state: "claimed" as const,
      delivery: { chatId: -1004366290625, chatType: "supergroup", threadId: 2 },
    };

    const turn = buildTelegramRunContinuationTurn(continuation, "actor-1");
    // Explicitly verify the continuation turn contains only safe continuation inspection text
    expect(turn.text).toContain("[Agent Bridge continuation]");
    expect(turn.text).toContain("Re-check current external state and continue the original objective");
    expect(turn.text).toContain("Do not repeat completed side effects.");
    expect(turn.text).toContain("Pending reason: Verify systemd service status after self-restart");
    // Queue only
    expect(turn.queueOnly).toBe(true);
    expect(turn.attachments).toEqual([]);
  });

  it("default production scanner path without injected options verifies live process containment and fails closed", async () => {
    const { db } = setup();
    const runId = "default-scanner-liveness-run";
    const surfaceIdentity = "telegram:interactive";
    const chatKey = "-1004366290625:2";
    const provider = "claude";

    db.insertRun(runId, { surfaceIdentity, chatKey }, provider);
    requestRunContinuation(db, {
      originRunId: runId,
      surfaceIdentity,
      chatKey,
      provider,
      reason: "Post-deploy health check",
      afterSeconds: 10,
    }, 1_000);

    // Reconcile rollout when processes were contained
    db.reconcileControlledRollout({
      reason: "interrupted_by_controlled_rollout",
      nowMs: 2_000,
    });

    const cont = listRunContinuations(db)[0];
    expect(cont.rolloutProvenance).toBeUndefined(); // Audit is attached by the post-fence claimant.

    // Mock getRunOwnedProcessState returning live (descendant still running)
    const spy = vi.spyOn(runOwnedProcesses, "getRunOwnedProcessState").mockReturnValue("live");

    const dispatch = vi.fn(async () => undefined);

    // Run production scanner with NO ClaimRunContinuationOptions
    await scanRunContinuations(db, surfaceIdentity, dispatch, 12_000);

    expect(dispatch).not.toHaveBeenCalled();
    const cancelled = listRunContinuations(db)[0];
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBe("originating Run process or descendant is still active");

    spy.mockRestore();
    db.close();
  });

  it("enforces verification-only read-only turn contract and suppresses mutation instructions for rollout continuations", () => {
    const rolloutContinuation = {
      version: 1 as const,
      id: "rollout-turn-test",
      originRunId: "rollout-turn-test",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-1004366290625:2",
      provider: "claude" as const,
      reason: "Verify systemd service status after self-restart",
      requestedAt: new Date(1000).toISOString(),
      dueAt: new Date(11000).toISOString(),
      expiresAt: new Date(7200000).toISOString(),
      state: "claimed" as const,
      delivery: { chatId: -1004366290625, chatType: "supergroup", threadId: 2 },
      rolloutProvenance: {
        reconciledAt: new Date(2000).toISOString(),
        reason: "interrupted_by_controlled_rollout",
        reconciliationAuditId: "audit-1",
        originRunId: "rollout-turn-test",
        surfaceIdentity: "telegram:interactive",
        chatKey: "-1004366290625:2",
        provider: "claude" as const,
      },
    };

    // Telegram turn
    const telegramTurn = buildTelegramRunContinuationTurn(rolloutContinuation, "actor-1");
    expect(telegramTurn.text).toContain("[Agent Bridge post-rollout verification]");
    expect(telegramTurn.text).toContain("Perform bounded read-only verification of current service health");
    expect(telegramTurn.text).toContain("Do not repeat completed side effects, apply mutations, or replay previous operations.");
    expect(telegramTurn.text).not.toContain("continue the original objective");
    expect(telegramTurn.executionMode).toBe("safe");
    expect(telegramTurn.verificationOnly).toBe(true);
    expect(telegramTurn.queueOnly).toBe(true);

    // Discord turn
    const discordContinuation = {
      ...rolloutContinuation,
      surfaceIdentity: "discord:guild-1",
      delivery: { chatId: "1234567890", chatType: "channel" },
    };
    const discordTurn = buildDiscordRunContinuationTurn(discordContinuation, "actor-2");
    expect(discordTurn.text).toContain("[Agent Bridge post-rollout verification]");
    expect(discordTurn.text).toContain("Perform bounded read-only verification of current service health");
    expect(discordTurn.text).toContain("Do not repeat completed side effects, apply mutations, or replay previous operations.");
    expect(discordTurn.text).not.toContain("continue the original objective");
    expect(discordTurn.executionMode).toBe("safe");
    expect(discordTurn.verificationOnly).toBe(true);
    expect(discordTurn.queueOnly).toBe(true);
  });
});
