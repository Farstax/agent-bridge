import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { persistProviderSession } from "../src/providers/sessionRuntime.js";
import {
  buildDiscordRunContinuationTurn,
  buildTelegramRunContinuationTurn,
  cancelPendingRunContinuation,
  claimDueRunContinuation,
  listRunContinuations,
  requestRunContinuation,
  scanRunContinuations,
  settleRunContinuation,
  requeueClaimedCapacityWait,
  claimCapacityWaitNotice,
  hasPendingCapacityWait,
} from "../src/runContinuation.js";

const paths: string[] = [];

function setup() {
  const path = join(tmpdir(), `run-continuation-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return { db: openDb(path, { serviceId: "run-continuation-test", runId: "test-process" }), path };
}

function requestForActiveRun(
  db: ReturnType<typeof openDb>,
  input: Parameters<typeof requestRunContinuation>[1],
  nowMs: number,
) {
  db.insertRun(input.originRunId, { surfaceIdentity: input.surfaceIdentity, chatKey: input.chatKey }, input.provider);
  return requestRunContinuation(db, input, nowMs);
}

function completeOriginRun(db: ReturnType<typeof openDb>, runId: string): void {
  const run = db.getRun(runId);
  const sessionId = `session-${runId}`;
  persistProviderSession(db, { surfaceIdentity: run.surface_identity ?? "$legacy", chatKey: run.chat_id }, run.bot, sessionId, runId);
  expect(db.updateRunCompleted(runId, "done", sessionId)).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already removed */ }
});

describe("ordinary Run continuation", () => {
  it("persists one bounded continuation for the originating Run", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-1",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100:42",
      provider: "codex",
      reason: "CI is still running",
      afterSeconds: 60,
    }, Date.parse("2026-10-04T12:00:00.000Z"));

    expect(continuation).toEqual(expect.objectContaining({
      id: "run-1",
      state: "pending",
      provider: "codex",
      dueAt: "2026-10-04T12:01:00.000Z",
    }));
    expect(listRunContinuations(db)).toHaveLength(1);
    db.close();
  });

  it("claims only once when due and never replays a claimed continuation", () => {
    const { db, path } = setup();
    requestForActiveRun(db, {
      originRunId: "run-2",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "claude",
      reason: "deployment convergence pending",
      afterSeconds: 5,
    }, 1_000);

    expect(claimDueRunContinuation(db, "run-2", 5_999)).toBeNull();
    completeOriginRun(db, "run-2");
    expect(claimDueRunContinuation(db, "run-2", 6_000)?.state).toBe("claimed");
    expect(claimDueRunContinuation(db, "run-2", 7_000)).toBeNull();
    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    expect(claimDueRunContinuation(reopened, "run-2", 8_000)).toBeNull();
    expect(listRunContinuations(reopened)[0].state).toBe("claimed");
    reopened.close();
  });

  it("allows a capacity wait to resume after its failed provider attempt settles", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 60,
      capacityWait: true,
    }, 1_000);

    expect(db.updateRunFailed("run-capacity", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    expect(claimDueRunContinuation(db, continuation.id, 61_000)?.state).toBe("claimed");
    db.close();
  });

  it("survives restart and dispatches a settled capacity wait only once", async () => {
    const { db, path } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-restart",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 6_000);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 7_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(reopened)[0]).toEqual(expect.objectContaining({ state: "completed", capacityWait: true }));
    reopened.close();
  });

  it("recovers a capacity continuation claimed before a crash and dispatches it exactly once on restart", async () => {
    const { db, path } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-crash-claimed",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    const claimed = claimDueRunContinuation(db, continuation.id, 6_000, { leaseMs: 400 });
    expect(claimed?.state).toBe("claimed");

    expect(hasPendingCapacityWait(db, "telegram:interactive", "123")).toBe(true);
    expect(hasPendingCapacityWait(db, "telegram:interactive", "123", continuation.id)).toBe(false);

    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen-crash", runId: "test-process-3" });
    expect(hasPendingCapacityWait(reopened, "telegram:interactive", "123")).toBe(true);

    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 6_500);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(reopened)[0]).toEqual(expect.objectContaining({ state: "completed", capacityWait: true }));

    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 7_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    reopened.close();
  });

  it("cleans retained attachment files and parent directory on capacity retirement", () => {
    const { db } = setup();
    const uploadDir = join(tmpdir(), `bridge-uploads-test-${randomUUID()}`);
    mkdirSync(uploadDir, { recursive: true });
    const attachmentPath = join(uploadDir, "photo.jpg");
    writeFileSync(attachmentPath, "dummy image data");
    expect(existsSync(attachmentPath)).toBe(true);

    db.enqueueMsg("telegram:interactive", "123", {
      prompt: "analyze photo",
      chatId: 123,
      threadId: null,
      chatType: "private",
      userId: 42,
      attachments: [attachmentPath],
      scheduledOccurrenceKey: null,
    });
    const pending = db.dequeueMsgs("telegram:interactive", "123");
    expect(pending).toHaveLength(1);

    expect(db.retireQueuedPendingMsgs("telegram:interactive", "123", [pending[0].id])).toBe(true);
    expect(existsSync(attachmentPath)).toBe(false);
    expect(existsSync(uploadDir)).toBe(false);
    db.close();
  });


  it("keeps a capacity wait pending when its wake did not claim progress", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-unclaimed",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    const dispatch = vi.fn(async () => false);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 6_000);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "pending", expiresAt: continuation.expiresAt }));
    db.close();
  });

  it("expires the original capacity lifetime without dispatching and reports it once", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-expiry",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    const expired = vi.fn();
    await scanRunContinuations(db, "telegram:interactive", vi.fn(), Date.parse(continuation.expiresAt), { onCapacityExpired: expired });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "expired" }));
    db.close();
  });

  it("cancels a claimed capacity wake before it can requeue the retained task", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-cancelled-wake",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    expect(claimDueRunContinuation(db, continuation.id, 6_000)?.state).toBe("claimed");
    expect(cancelPendingRunContinuation(db, continuation.id, "session reset by user", 6_001)).toBe(true);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "cancelled" }));
    db.close();
  });

  it("reschedules the same logical capacity wait after another rejected attempt", () => {
    const { db } = setup();
    const first = requestForActiveRun(db, {
      continuationId: "capacity-wait:42",
      originRunId: "run-capacity-first",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed(first.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    expect(claimDueRunContinuation(db, first.id, 6_000)?.state).toBe("claimed");

    db.insertRun("run-capacity-second", { surfaceIdentity: "telegram:interactive", chatKey: "123" }, "codex");
    expect(db.updateRunFailed("run-capacity-second", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    const rescheduled = requestRunContinuation(db, {
      continuationId: first.id,
      originRunId: "run-capacity-second",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 60,
      capacityWait: true,
    }, 7_000);
    expect(rescheduled).toEqual(expect.objectContaining({ id: first.id, originRunId: "run-capacity-second", state: "pending" }));
    expect(rescheduled.expiresAt).toBe(first.expiresAt);
    expect(listRunContinuations(db)).toHaveLength(1);
    db.close();
  });

  it("persists the single capacity notice decision across a restart", () => {
    const { db, path } = setup();
    const continuation = requestForActiveRun(db, {
      continuationId: "capacity-wait:notice",
      originRunId: "run-capacity-notice",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(claimCapacityWaitNotice(db, continuation.id)).toBe(true);
    expect(claimCapacityWaitNotice(db, continuation.id)).toBe(false);
    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    expect(claimCapacityWaitNotice(reopened, continuation.id)).toBe(false);
    expect(listRunContinuations(reopened)[0]).toEqual(expect.objectContaining({ capacityNoticeSent: true }));
    reopened.close();
  });

  it("does not resume while the originating Run is still active", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-active",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);

    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 6_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).toBe("pending");

    completeOriginRun(db, "run-active");
    await scanRunContinuations(db, "telegram:interactive", dispatch, 6_001);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0].state).toBe("completed");
    db.close();
  });

  it("real continuation callback does not complete continuation when child interactive turn fails", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-failed-real-dispatch",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-failed-real-dispatch");

    const { ProviderFallbackChain } = await import("../src/providerFallback.js");
    const { dispatchInteractiveTurnWithFallback } = await import("../src/interactiveBot.js");
    const fallbackChain = new ProviderFallbackChain(["codex"], db, "telegram:interactive", () => true);
    const mockEngine = {
      handleInteractiveTurn: vi.fn().mockResolvedValue("failed"),
      executeClaimedMessage: vi.fn(),
    };
    const deps = {
      engines: { codex: mockEngine as any },
      fallbackChain,
      db,
      notify: vi.fn(),
    };

    const continuationCallback = async (continuation: RunContinuation) => {
      const turn = buildTelegramRunContinuationTurn(continuation, 42);
      return dispatchInteractiveTurnWithFallback(turn, deps, new Set([continuation.provider]));
    };

    await expect(scanRunContinuations(db, "telegram:interactive", continuationCallback, 6_000))
      .rejects.toThrow();
    expect(listRunContinuations(db)[0].state).toBe("failed");
    db.close();
  });

  it("does not complete continuation when dispatch reports queued and preserves claimed state", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-queued-dispatch",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-queued-dispatch");

    await scanRunContinuations(db, "telegram:interactive", async () => "queued", 6_000);
    const continuations = listRunContinuations(db);
    expect(continuations[0].state).toBe("claimed");
    db.close();
  });

  it("does not mark a continuation complete when dispatch reports a failed Run", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-failed-dispatch",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-failed-dispatch");

    await expect(scanRunContinuations(db, "telegram:interactive", async () => "failed", 6_000))
      .rejects.toThrow(/did not settle/);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "failed" }));
    db.close();
  });

  it("does not resume if the provider session binding changed after the origin Run", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-session-cleared",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-session-cleared");
    persistProviderSession(db, { surfaceIdentity: "telegram:interactive", chatKey: "123" }, "codex", null);

    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 6_000);

    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({
      state: "cancelled",
      error: "originating provider session binding changed",
    }));
    db.close();
  });

  it("preserves pending continuation across restart and dispatches it exactly once", async () => {
    const { db, path } = setup();
    requestForActiveRun(db, {
      originRunId: "run-3",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "qualification pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-3");
    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 6_000);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 7_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(reopened)[0].state).toBe("completed");
    reopened.close();
  });

  it("expires bounded continuation instead of dispatching indefinitely", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-4",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "wait",
      afterSeconds: 5,
    }, 1_000);
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 1_000 + 2 * 60 * 60 * 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

  it("records failed dispatch and does not retry it", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-5",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-5");
    const dispatch = vi.fn(async () => { throw new Error("dispatch failed"); });
    await expect(scanRunContinuations(db, "telegram:interactive", dispatch, 6_000)).rejects.toThrow("dispatch failed");
    await scanRunContinuations(db, "telegram:interactive", dispatch, 7_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "failed", error: "dispatch failed" }));
    db.close();
  });

  it("builds a continuation turn back into the exact Telegram conversation", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-6",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100:42",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 60,
    }, 1_000);
    const turn = buildTelegramRunContinuationTurn(continuation, "123");
    expect(turn.chatKey).toBe("-100:42");
    expect(turn.threadId).toBe("42");
    expect(turn.delivery).toEqual({ chatId: -100, chatType: "supergroup", threadId: 42 });
    expect(turn.text).toContain("CI pending");
    db.close();
  });

  it("builds a continuation turn back into the exact Discord channel", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-discord",
      surfaceIdentity: "discord:interactive",
      chatKey: "123456789012345678",
      provider: "claude",
      reason: "CI pending",
      afterSeconds: 60,
    }, 1_000);
    const turn = buildDiscordRunContinuationTurn(continuation, "987654321");
    expect(turn.chatKey).toBe("123456789012345678");
    expect(turn.delivery).toEqual({ chatId: "123456789012345678", chatType: "private" });
    expect(turn.surroundingContext).toEqual([]);
    expect(turn.text).toContain("CI pending");
    db.close();
  });

  it("rejects unbounded or too-short delays", () => {
    const { db } = setup();
    const base = {
      originRunId: "run-7",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex" as const,
      reason: "wait",
    };
    expect(() => requestRunContinuation(db, { ...base, afterSeconds: 4 })).toThrow(/between 5 and 1800/);
    expect(() => requestRunContinuation(db, { ...base, afterSeconds: 1801 })).toThrow(/between 5 and 1800/);
    db.close();
  });

  it("cancels a pending continuation when its originating Run fails or is cancelled", async () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-cancelled",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);

    expect(cancelPendingRunContinuation(db, "run-cancelled", "originating Run failed", 2_000)).toBe(true);
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 6_000);

    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({
      state: "cancelled",
      error: "originating Run failed",
    }));
    db.close();
  });

  it("settles only a claimed continuation", () => {
    const { db } = setup();
    requestForActiveRun(db, {
      originRunId: "run-8",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "wait",
      afterSeconds: 5,
    }, 1_000);
    settleRunContinuation(db, "run-8", "completed", undefined, 2_000);
    completeOriginRun(db, "run-8");
    expect(listRunContinuations(db)[0].state).toBe("pending");
    claimDueRunContinuation(db, "run-8", 6_000);
    settleRunContinuation(db, "run-8", "completed", undefined, 7_000);
    expect(listRunContinuations(db)[0].state).toBe("completed");
    db.close();
  });

  it("does not allow competing runner to reclaim active claimed capacity wait (P1)", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-origin",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [999],
    }, 1_000);
    expect(db.updateRunFailed("run-origin", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Runner 1 claims it at due time:
    const claimed = claimDueRunContinuation(db, continuation.id, 6_000, { runId: "runner-1" });
    expect(claimed).not.toBeNull();
    expect(claimed?.state).toBe("claimed");

    // Runner 2 attempts to claim it while Runner 1 is still alive and lease active:
    const competing = claimDueRunContinuation(db, continuation.id, 7_000, {
      runId: "runner-2",
      isProcessAlive: (runId) => runId === "runner-1",
    });
    expect(competing).toBeNull();
    db.close();
  });

  it("reclaims stale claimed capacity wait after claimant crashes before lock (P1)", () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const queuedId = db.dequeueMsgs("telegram:interactive", "123")[0].id;
    // Re-enqueue so it exists in pending_messages:
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];

    const continuation = requestForActiveRun(db, {
      originRunId: "run-origin-crash",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed("run-origin-crash", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Runner 1 claimed it:
    claimDueRunContinuation(db, continuation.id, 6_000, { runId: "dead-runner" });

    // Dead-runner crashed (isProcessAlive returns false):
    const reclaimed = claimDueRunContinuation(db, continuation.id, 8_000, {
      runId: "recovering-runner",
      isProcessAlive: (runId) => runId !== "dead-runner",
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.state).toBe("claimed");
    db.close();
  });

  it("settles as completed without re-executing if task completed before crash (P1)", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-origin-done",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [888], // Note: 888 does NOT exist in pending_messages because it completed!
    }, 1_000);
    expect(db.updateRunFailed("run-origin-done", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Claimed before crash:
    claimDueRunContinuation(db, continuation.id, 6_000, { runId: "dead-runner" });

    const dispatch = vi.fn();
    // Scan after crash:
    await scanRunContinuations(db, "telegram:interactive", dispatch, 10_000, {
      isProcessAlive: () => false,
    });

    // Should NOT have dispatched again:
    expect(dispatch).not.toHaveBeenCalled();
    // Should be settled as completed:
    expect(listRunContinuations(db)[0].state).toBe("completed");
    db.close();
  });

  it("does not mark capacity wait expired while chat execution lock is held (P1)", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const msg = db.dequeueMsgs("telegram:interactive", "123")[0];
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];

    const continuation = requestForActiveRun(db, {
      originRunId: "run-origin-exp",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed("run-origin-exp", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Hold chat execution lock (active execution in flight):
    const handle = db.acquireLock("telegram:interactive", "123");
    expect(handle).not.toBeNull();

    const onExpired = vi.fn();
    // Scan at expiry time:
    await scanRunContinuations(db, "telegram:interactive", vi.fn(), Date.parse(continuation.expiresAt) + 1_000, {
      onCapacityExpired: onExpired,
    });

    // Must NOT be marked expired while lock is held:
    expect(onExpired).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).not.toBe("expired");

    // Release chat lock:
    db.unlock(handle!);

    // Next scan now successfully retires and marks expired:
    await scanRunContinuations(db, "telegram:interactive", vi.fn(), Date.parse(continuation.expiresAt) + 2_000, {
      onCapacityExpired: onExpired,
    });
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

  it("competing runner cannot reclaim active claimed capacity wait before lease expiry under default options", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-compete-default",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed("run-compete-default", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Runner 1 claims with default lease (90s) at t=6000
    const claim1 = claimDueRunContinuation(db, continuation.id, 6_000, { runId: "runner-1" });
    expect(claim1).not.toBeNull();
    expect(claim1?.claimRunId).toBe("runner-1");

    // Runner 2 attempts to claim at t=10000 (before 90s lease expires, default options - no custom isProcessAlive)
    const competing = claimDueRunContinuation(db, continuation.id, 10_000, { runId: "runner-2" });
    expect(competing).toBeNull();

    // Runner 2 attempts to claim at t=100000 (after 90s lease expired)
    const reclaimed = claimDueRunContinuation(db, continuation.id, 100_000, { runId: "runner-2" });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.claimRunId).toBe("runner-2");
    db.close();
  });

  it("stale claimant callback cannot settle or requeue continuation after newer claimant took ownership", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-stale-callback",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);
    expect(db.updateRunFailed("run-stale-callback", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Runner 1 claims with short lease (1000ms) at t=6000
    claimDueRunContinuation(db, continuation.id, 6_000, { runId: "runner-1", leaseMs: 1_000 });

    // Lease expires at t=8000; Runner 2 claims continuation
    const runner2Claim = claimDueRunContinuation(db, continuation.id, 8_000, { runId: "runner-2", leaseMs: 10_000 });
    expect(runner2Claim?.claimRunId).toBe("runner-2");

    // Stale runner 1 returns late at t=8500 and attempts to requeue:
    requeueClaimedCapacityWait(db, continuation.id, 8_500, "runner-1");
    // Ownership MUST still belong to runner 2, state still claimed:
    let current = listRunContinuations(db)[0];
    expect(current.state).toBe("claimed");
    expect(current.claimRunId).toBe("runner-2");

    // Stale runner 1 attempts to settle as completed:
    settleRunContinuation(db, continuation.id, "completed", undefined, 8_600, "runner-1");
    current = listRunContinuations(db)[0];
    expect(current.state).toBe("claimed");
    expect(current.claimRunId).toBe("runner-2");

    // Authoritative runner 2 settles as completed:
    settleRunContinuation(db, continuation.id, "completed", undefined, 9_000, "runner-2");
    current = listRunContinuations(db)[0];
    expect(current.state).toBe("completed");
    db.close();
  });

  it("settleRunContinuation cannot overwrite cancelled or completed continuation", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-protect-state",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
    }, 1_000);

    // User cancels wait:
    expect(cancelPendingRunContinuation(db, continuation.id, "user stopped")).toBe(true);
    expect(listRunContinuations(db)[0].state).toBe("cancelled");

    // Stale expiry or completion callback:
    settleRunContinuation(db, continuation.id, "expired", undefined, 10_000);
    expect(listRunContinuations(db)[0].state).toBe("cancelled");

    settleRunContinuation(db, continuation.id, "completed", undefined, 10_000);
    expect(listRunContinuations(db)[0].state).toBe("cancelled");
    db.close();
  });

  it("recovers from terminal expiry notification delivery failure and retries on subsequent scan", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];

    const continuation = requestForActiveRun(db, {
      originRunId: "run-exp-retry",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed("run-exp-retry", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    const onExpired = vi.fn().mockRejectedValueOnce(new Error("Telegram transient delivery failure"))
      .mockResolvedValueOnce(undefined);

    const expiryTime = Date.parse(continuation.expiresAt) + 1_000;

    // First scan: delivery fails (throws error)
    await expect(
      scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, {
        onCapacityExpired: onExpired,
        leaseMs: 500,
      })
    ).rejects.toThrow("Telegram transient delivery failure");

    // Original pending message was safely retired from queue (cannot be replayed):
    expect(db.hasAnyPendingMessageId("telegram:interactive", "123", [pendingMsg.id])).toBe(false);

    // Continuation is marked expiryDeliveryPending and claimed, NOT expired:
    const afterFail = listRunContinuations(db)[0];
    expect(afterFail.state).toBe("claimed");
    expect(afterFail.expiryDeliveryPending).toBe(true);

    // Second scan (after lease): delivery succeeds
    await scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime + 1_000, {
      onCapacityExpired: onExpired,
    });

    expect(onExpired).toHaveBeenCalledTimes(2);
    const afterSuccess = listRunContinuations(db)[0];
    expect(afterSuccess.state).toBe("expired");
    db.close();
  });

  it("concurrent scans do not duplicate final expiry notification", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];

    const continuation = requestForActiveRun(db, {
      originRunId: "run-exp-concurrent",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed("run-exp-concurrent", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    const onExpired = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const expiryTime = Date.parse(continuation.expiresAt) + 1_000;

    // Run two concurrent scans:
    await Promise.all([
      scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, { onCapacityExpired: onExpired, runId: "runner-a" }),
      scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, { onCapacityExpired: onExpired, runId: "runner-b" }),
    ]);

    // Exactly one scan delivered the notification:
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

});
