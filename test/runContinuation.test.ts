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
  reconcileRunContinuations,
  linkRunContinuationRun,
  linkCapacityContinuationRun,
} from "../src/runContinuation.js";
import { BridgeEngine } from "../src/engine.js";

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

  it("does not complete a capacity wait merely because its queue receipt disappeared", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-ambiguous", surfaceIdentity: "telegram:interactive", chatKey: "123",
      provider: "codex", reason: "capacity wait", afterSeconds: 5, capacityWait: true,
      retainedPendingMessageIds: [999],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    await scanRunContinuations(db, "telegram:interactive", async () => true, 6_000);
    expect(listRunContinuations(db)[0].state).not.toBe("completed");
    db.close();
  });

  it.each(["done", "failed", "running"] as const)("requires a matching completed successor to settle a capacity wait (%s)", async (status) => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: `origin-${status}`, surfaceIdentity: "telegram:interactive", chatKey: "123",
      provider: "codex", reason: "capacity wait", afterSeconds: 5, capacityWait: true,
      retainedPendingMessageIds: [999],
    }, 1_000);
    db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED");
    await scanRunContinuations(db, "telegram:interactive", async (claim) => {
      db.insertRun(`successor-${status}`, { surfaceIdentity: claim.surfaceIdentity, chatKey: claim.chatKey }, "codex");
      expect(linkCapacityContinuationRun(db, claim.id, claim.claimToken!, `successor-${status}`)).toBe(true);
      if (status === "done") completeOriginRun(db, `successor-${status}`);
      if (status === "failed") db.updateRunFailed(`successor-${status}`, "failure");
      return true;
    }, 6_000);
    expect(listRunContinuations(db)[0].state === "completed").toBe(status === "done");
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
      retainedPendingMessageIds: [999],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    const dispatch = vi.fn(async (claim) => {
      reopened.insertRun(`successor-${claim.id}`, { surfaceIdentity: claim.surfaceIdentity, chatKey: claim.chatKey }, "codex");
      expect(linkCapacityContinuationRun(reopened, claim.id, claim.claimToken!, `successor-${claim.id}`)).toBe(true);
      completeOriginRun(reopened, `successor-${claim.id}`);
    });
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 6_000);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, 7_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(reopened)[0]).toEqual(expect.objectContaining({ state: "completed", capacityWait: true }));
    reopened.close();
  });

  it("recovers a capacity continuation claimed before a crash and dispatches it exactly once on restart", async () => {
    const { db, path } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "task", chatId: 123, chatType: "private", userId: 42 });
    const receipt = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-capacity-crash-claimed",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "all permitted providers are temporarily at capacity",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [receipt.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    const claimed = claimDueRunContinuation(db, continuation.id, 6_000, { leaseMs: 400 });
    expect(claimed?.state).toBe("claimed");

    expect(hasPendingCapacityWait(db, "telegram:interactive", "123")).toBe(true);
    expect(hasPendingCapacityWait(db, "telegram:interactive", "123", continuation.id)).toBe(false);

    db.close();

    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen-crash", runId: "test-process-3" });
    expect(hasPendingCapacityWait(reopened, "telegram:interactive", "123")).toBe(true);

    const dispatch = vi.fn(async (claim) => {
      reopened.insertRun(`successor-${claim.id}`, { surfaceIdentity: claim.surfaceIdentity, chatKey: claim.chatKey }, "codex");
      expect(linkCapacityContinuationRun(reopened, claim.id, claim.claimToken!, `successor-${claim.id}`)).toBe(true);
      completeOriginRun(reopened, `successor-${claim.id}`);
      expect(reopened.retireQueuedPendingMsgs(claim.surfaceIdentity, claim.chatKey, [receipt.id])).toBe(true);
    });
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
    const claim = claimDueRunContinuation(db, continuation.id, 6_000, { runId: "dead-runner" })!;
    db.insertRun("successor-before-crash", { surfaceIdentity: continuation.surfaceIdentity, chatKey: continuation.chatKey }, "codex");
    expect(linkCapacityContinuationRun(db, continuation.id, claim.claimToken!, "successor-before-crash")).toBe(true);
    completeOriginRun(db, "successor-before-crash");

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

  it("releases the lane when a claimed wait has lost its retained receipt", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "origin-missing-receipt", surfaceIdentity: "telegram:interactive", chatKey: "123",
      provider: "codex", reason: "capacity wait", afterSeconds: 5, capacityWait: true,
      retainedPendingMessageIds: [999],
    }, 1_000);
    db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED");
    const claim = claimDueRunContinuation(db, continuation.id, 6_000)!;
    db.enqueueMsg(continuation.surfaceIdentity, continuation.chatKey, { prompt: "other task", chatId: 123, chatType: "private", userId: 42 });
    const engine = new BridgeEngine({ surfaceIdentity: continuation.surfaceIdentity, kind: "codex",
      botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", busyMessageMode: "augment", pollIntervalMs: 1000 }, db, {} as any);
    await engine.recoverPendingQueue(continuation.chatKey, continuation.id, claim.claimToken);
    expect(db.hasChatLock(continuation.chatKey)).toBe(false);
    expect(db.pendingMsgCount(continuation.surfaceIdentity, continuation.chatKey)).toBe(1);
    db.close();
  });

  it("reconciles a failed successor after restart without replaying its consumed receipt", async () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "origin-failed-restart", surfaceIdentity: "telegram:interactive", chatKey: "123",
      provider: "codex", reason: "capacity wait", afterSeconds: 5, capacityWait: true,
      retainedPendingMessageIds: [888],
    }, 1_000);
    db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED");
    const claim = claimDueRunContinuation(db, continuation.id, 6_000)!;
    db.insertRun("successor-failed-restart", { surfaceIdentity: continuation.surfaceIdentity, chatKey: continuation.chatKey }, "codex");
    expect(linkCapacityContinuationRun(db, continuation.id, claim.claimToken!, "successor-failed-restart")).toBe(true);
    db.updateRunFailed("successor-failed-restart", "auth required");
    const dispatch = vi.fn();
    await scanRunContinuations(db, continuation.surfaceIdentity, dispatch, 100_000, { isProcessAlive: () => false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).toBe("failed");
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
    db.enqueueMsg("telegram:interactive", "123", { prompt: "task", chatId: 123, chatType: "private", userId: 42 });
    const receipt = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-stale-callback",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [receipt.id],
    }, 1_000);
    expect(db.updateRunFailed("run-stale-callback", "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    // Runner 1 claims with short lease (1000ms) at t=6000
    const runner1Claim = claimDueRunContinuation(db, continuation.id, 6_000, { runId: "runner-1", leaseMs: 1_000 })!;

    // Lease expires at t=8000; Runner 2 claims continuation
    const runner2Claim = claimDueRunContinuation(db, continuation.id, 8_000, { runId: "runner-2", leaseMs: 10_000 });
    expect(runner2Claim?.claimRunId).toBe("runner-2");

    db.insertRun("successor-fenced", { surfaceIdentity: continuation.surfaceIdentity, chatKey: continuation.chatKey }, "codex");
    expect(linkCapacityContinuationRun(db, continuation.id, runner1Claim.claimToken!, "successor-fenced")).toBe(false);
    expect(linkRunContinuationRun(db, continuation.id, "successor-fenced")).toBe(false);
    expect(linkCapacityContinuationRun(db, continuation.id, runner2Claim!.claimToken!, "successor-fenced")).toBe(true);
    completeOriginRun(db, "successor-fenced");
    expect(db.retireQueuedPendingMsgs(continuation.surfaceIdentity, continuation.chatKey, [receipt.id])).toBe(true);

    // Stale runner 1 returns late at t=8500 and attempts to requeue:
    requeueClaimedCapacityWait(db, continuation.id, 8_500, runner1Claim.claimToken);
    // Ownership MUST still belong to runner 2, state still claimed:
    let current = listRunContinuations(db)[0];
    expect(current.state).toBe("claimed");
    expect(current.claimRunId).toBe("runner-2");

    // Stale runner 1 attempts to settle as completed:
    settleRunContinuation(db, continuation.id, "completed", undefined, 8_600, runner1Claim.claimToken);
    current = listRunContinuations(db)[0];
    expect(current.state).toBe("claimed");
    expect(current.claimRunId).toBe("runner-2");

    // Authoritative runner 2 settles as completed:
    settleRunContinuation(db, continuation.id, "completed", undefined, 9_000, runner2Claim.claimToken);
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

  it("fences concurrent expiry delivery attempts from the same service run", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-exp-same-runner",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    let releaseDelivery!: () => void;
    const deliveryPending = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const onExpired = vi.fn(() => deliveryPending);
    const expiryTime = Date.parse(continuation.expiresAt) + 1_000;

    const first = scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, {
      onCapacityExpired: onExpired,
      runId: "same-service-run",
    });
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    const second = scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, {
      onCapacityExpired: onExpired,
      runId: "same-service-run",
    });
    await second;
    expect(onExpired).toHaveBeenCalledTimes(1);

    releaseDelivery();
    await first;
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

  it("does not supersede a known-live expiry delivery after its lease", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-exp-live-claimant",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    let releaseDelivery!: () => void;
    const deliveryPending = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const onExpired = vi.fn(() => deliveryPending);
    const expiryTime = Date.parse(continuation.expiresAt) + 1_000;
    const options = { onCapacityExpired: onExpired, runId: "live-runner", leaseMs: 1_000, isProcessAlive: () => true };

    const first = scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime, options);
    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
    await scanRunContinuations(db, "telegram:interactive", vi.fn(), expiryTime + 1_001, options);
    expect(onExpired).toHaveBeenCalledTimes(1);

    releaseDelivery();
    await first;
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

  it("fences a stale callback after same-service lease reclamation", () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "task", chatId: 123, chatType: "private", userId: 42 });
    const receipt = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-same-service-stale",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [receipt.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    const first = claimDueRunContinuation(db, continuation.id, 6_000, { runId: "same-service", leaseMs: 1_000 })!;
    const second = claimDueRunContinuation(db, continuation.id, 8_000, { runId: "same-service", leaseMs: 10_000 })!;
    const firstToken = (first as any).claimToken ?? first.claimRunId;
    const secondToken = (second as any).claimToken ?? second.claimRunId;

    db.insertRun("successor-fenced", { surfaceIdentity: continuation.surfaceIdentity, chatKey: continuation.chatKey }, "codex");
    expect(linkCapacityContinuationRun(db, continuation.id, second.claimToken!, "successor-fenced")).toBe(true);
    completeOriginRun(db, "successor-fenced");
    expect(db.retireQueuedPendingMsgs(continuation.surfaceIdentity, continuation.chatKey, [receipt.id])).toBe(true);

    expect(firstToken).not.toBe(secondToken);
    settleRunContinuation(db, continuation.id, "completed", undefined, 8_100, firstToken);
    requeueClaimedCapacityWait(db, continuation.id, 8_200, firstToken);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "claimed", claimRunId: "same-service" }));

    settleRunContinuation(db, continuation.id, "completed", undefined, 8_300, secondToken);
    expect(listRunContinuations(db)[0].state).toBe("completed");
    db.close();
  });

  it("keeps a thrown capacity wake under its continuation for a bounded retry", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-wake-throw",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);

    await scanRunContinuations(db, "telegram:interactive", async () => {
      throw new Error("transient queue recovery failure");
    }, 6_000);

    expect(db.hasAnyPendingMessageId("telegram:interactive", "123", [pendingMsg.id])).toBe(true);
    expect(hasPendingCapacityWait(db, "telegram:interactive", "123")).toBe(true);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "pending", capacityWait: true }));
    db.close();
  });

  it("settles a completed retained task during expiry without stranding its claimed wait", async () => {
    const { db } = setup();
    db.enqueueMsg("telegram:interactive", "123", { prompt: "test prompt", chatId: 123, chatType: "private", userId: 42 });
    const pendingMsg = db.dequeueMsgs("telegram:interactive", "123")[0];
    const continuation = requestForActiveRun(db, {
      originRunId: "run-expiry-completed-task",
      surfaceIdentity: "telegram:interactive",
      chatKey: "123",
      provider: "codex",
      reason: "capacity wait",
      afterSeconds: 5,
      capacityWait: true,
      retainedPendingMessageIds: [pendingMsg.id],
    }, 1_000);
    expect(db.updateRunFailed(continuation.originRunId, "MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    const claimed = claimDueRunContinuation(db, continuation.id, 6_000, { leaseMs: 500 })!;
    db.insertRun("successor-expiry", { surfaceIdentity: continuation.surfaceIdentity, chatKey: continuation.chatKey }, "codex");
    expect(linkCapacityContinuationRun(db, continuation.id, claimed.claimToken!, "successor-expiry")).toBe(true);
    completeOriginRun(db, "successor-expiry");
    expect(db.retireQueuedPendingMsgs("telegram:interactive", "123", [pendingMsg.id])).toBe(true);

    await scanRunContinuations(db, "telegram:interactive", vi.fn(), Date.parse(continuation.expiresAt) + 1_000);

    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "completed", claimToken: claimed.claimToken }));
    db.close();
  });

  it("carries scheduledOccurrenceKey correlation on continuation turns", () => {
    const { db } = setup();
    const continuation = requestForActiveRun(db, {
      originRunId: "run-turn-key",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100:42",
      provider: "codex",
      reason: "CI pending",
      afterSeconds: 60,
    }, 1_000);
    const tgTurn = buildTelegramRunContinuationTurn(continuation, "123");
    expect(tgTurn.scheduledOccurrenceKey).toBe("run-continuation:v1:run-turn-key");

    const discordContinuation = requestForActiveRun(db, {
      originRunId: "run-discord-key",
      surfaceIdentity: "discord:interactive",
      chatKey: "123456789",
      provider: "claude",
      reason: "CI pending",
      afterSeconds: 60,
    }, 1_000);
    const dcTurn = buildDiscordRunContinuationTurn(discordContinuation, "456");
    expect(dcTurn.scheduledOccurrenceKey).toBe("run-continuation:v1:run-discord-key");
    db.close();
  });
  it("settles a queued continuation to completed when the queued turn later executes and succeeds", async () => {
    const { db } = setup();
    const chatKey = "123";
    requestForActiveRun(db, {
      originRunId: "run-queued-e2e-ok",
      surfaceIdentity: "telegram:interactive",
      chatKey,
      provider: "claude",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-queued-e2e-ok");

    const cliMock = vi.fn().mockImplementation(async (_cmd, _args, _cwd, opts) => {
      opts?.onEvent?.({
        type: "run.started",
        version: 1,
        id: "evt-start",
        runId: opts.eventContext.runId,
        timestamp: new Date().toISOString(),
        bot: "claude",
        chatId: chatKey,
        chatKey,
        command: "cursor",
        cwd: "/tmp",
        model: null,
      });
      opts?.onEvent?.({
        type: "run.completed",
        version: 1,
        id: "evt-done",
        runId: opts.eventContext.runId,
        timestamp: new Date().toISOString(),
        bot: "claude",
        chatId: chatKey,
        chatKey,
        text: "Continuation work completed",
        sessionId: "session-succ",
      });
      return { stdout: "Continuation work completed", stderr: "", exitCode: 0 };
    });

    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind: "claude",
      botConfig: { command: "cursor", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
    }, db, {
      getSurfaceCapabilities: () => ({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any, {
      runCli: cliMock,
      runCliAsync: cliMock,
      runProviderInvocation: async (_bot, _p, _c, _i, _o, opts) => {
        await cliMock("cursor", [], "/tmp", opts);
        return { text: "Continuation work completed", sessionId: "session-succ", stopReason: "end_turn" };
      },
    } as any);

    // Acquire lock on lane to force incoming turn to queue
    const handle = db.acquireLock("telegram:interactive", chatKey, "busy-owner");
    expect(handle).not.toBeNull();

    // Scan continuations: dispatch should return "queued"
    await scanRunContinuations(db, "telegram:interactive", async (c) => {
      const turn = buildTelegramRunContinuationTurn(c, "42");
      return engine.handleInteractiveTurn(turn);
    }, 6_000);

    // Verify continuation is claimed and pending message has correlation key
    const continuations = listRunContinuations(db);
    expect(continuations[0].state).toBe("claimed");
    expect(db.hasPendingMessageForCorrelationKey("telegram:interactive", "run-continuation:v1:run-queued-e2e-ok")).toBe(true);

    // The active owner drains the queue using its owned handle
    const nextMsg = db.claimNextPendingMsg(handle!);
    expect(nextMsg).not.toBeNull();
    await (engine as any)._drainQueueAndUnlock(handle!, nextMsg);

    const settled = listRunContinuations(db);
    expect(settled[0].state).toBe("completed");
    expect(settled[0].successorRunId).toBeTruthy();
    db.close();
  });

  it("settles a queued continuation to failed when the queued turn later executes and fails", async () => {
    const { db } = setup();
    const chatKey = "124";
    requestForActiveRun(db, {
      originRunId: "run-queued-e2e-fail",
      surfaceIdentity: "telegram:interactive",
      chatKey,
      provider: "claude",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-queued-e2e-fail");

    const cliMock = vi.fn().mockImplementation(async (_cmd, _args, _cwd, opts) => {
      opts?.onEvent?.({
        type: "run.started",
        version: 1,
        id: "evt-start",
        runId: opts.eventContext.runId,
        timestamp: new Date().toISOString(),
        bot: "claude",
        chatId: chatKey,
        chatKey,
        command: "cursor",
        cwd: "/tmp",
        model: null,
      });
      opts?.onEvent?.({
        type: "run.failed",
        version: 1,
        id: "evt-fail",
        runId: opts.eventContext.runId,
        timestamp: new Date().toISOString(),
        bot: "claude",
        chatId: chatKey,
        chatKey,
        error: "fatal provider crash",
      });
      throw new Error("fatal provider crash");
    });

    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind: "claude",
      botConfig: { command: "cursor", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
    }, db, {
      getSurfaceCapabilities: () => ({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any, {
      runCli: cliMock,
      runCliAsync: cliMock,
      runProviderInvocation: async (_bot, _p, _c, _i, _o, opts) => cliMock("cursor", [], "/tmp", opts),
    } as any);

    const handle = db.acquireLock("telegram:interactive", chatKey, "busy-owner");
    await scanRunContinuations(db, "telegram:interactive", async (c) => {
      const turn = buildTelegramRunContinuationTurn(c, "42");
      return engine.handleInteractiveTurn(turn);
    }, 6_000);

    const nextMsg = db.claimNextPendingMsg(handle!);
    expect(nextMsg).not.toBeNull();
    await (engine as any)._drainQueueAndUnlock(handle!, nextMsg);

    const settled = listRunContinuations(db);
    expect(settled[0].state).toBe("failed");
    db.close();
  });

  it("settles a queued continuation to cancelled when /stop arrives while queued", async () => {
    const { db } = setup();
    const chatKey = "125";
    requestForActiveRun(db, {
      originRunId: "run-queued-e2e-stop",
      surfaceIdentity: "telegram:interactive",
      chatKey,
      provider: "claude",
      reason: "CI pending",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-queued-e2e-stop");

    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind: "claude",
      botConfig: { command: "cursor", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
    }, db, {
      getSurfaceCapabilities: () => ({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any, {
      runCli: vi.fn(),
      runCliAsync: vi.fn(),
      runProviderInvocation: vi.fn(),
    } as any);

    const handle = db.acquireLock("telegram:interactive", chatKey, "busy-owner");
    await scanRunContinuations(db, "telegram:interactive", async (c) => {
      const turn = buildTelegramRunContinuationTurn(c, "42");
      return engine.handleInteractiveTurn(turn);
    }, 6_000);

    expect(db.hasPendingMessageForCorrelationKey("telegram:interactive", "run-continuation:v1:run-queued-e2e-stop")).toBe(true);
    expect(listRunContinuations(db)[0].state).toBe("claimed");

    // Send /stop
    const stopOutcome = await engine.handleInteractiveTurn({
      surfaceIdentity: "telegram:interactive",
      chatKey,
      actorId: "42",
      messageId: "stop-msg",
      text: "/stop",
      delivery: { chatId: 125, chatType: "private" },
    });
    expect(stopOutcome).toBe("fenced");

    // Continuation should be cancelled and pending messages discarded
    expect(listRunContinuations(db)[0].state).toBe("cancelled");
    expect(db.hasPendingMessageForCorrelationKey("telegram:interactive", "run-continuation:v1:run-queued-e2e-stop")).toBe(false);
    db.unlock(handle!);
    db.close();
  });

  it("reconcileRunContinuations reconciles restart state without leaving permanent orphans or replaying completed work", () => {
    const { db } = setup();

    // 1. Claimed continuation with pending message in queue remains claimed
    const c1 = requestForActiveRun(db, {
      originRunId: "run-rec-1",
      surfaceIdentity: "telegram:interactive",
      chatKey: "126",
      provider: "claude",
      reason: "wait",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-rec-1");
    claimDueRunContinuation(db, "run-rec-1", 6_000);
    db.enqueueMsg("telegram:interactive", "126", {
      prompt: "continuation turn",
      chatId: "rec-1",
      chatType: "private",
      scheduledOccurrenceKey: "run-continuation:v1:run-rec-1",
    });

    // 2. Claimed continuation with completed successor run settles completed
    const c2 = requestForActiveRun(db, {
      originRunId: "run-rec-2",
      surfaceIdentity: "telegram:interactive",
      chatKey: "127",
      provider: "claude",
      reason: "wait",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-rec-2");
    claimDueRunContinuation(db, "run-rec-2", 6_000);
    db.insertRun("successor-run-2", { surfaceIdentity: "telegram:interactive", chatKey: "127" }, "claude");
    db.updateRunCompleted("successor-run-2", "success", "session-2");
    linkRunContinuationRun(db, "run-rec-2", "successor-run-2");

    // 3. Claimed continuation with no pending message and no successor run settles failed
    const c3 = requestForActiveRun(db, {
      originRunId: "run-rec-3",
      surfaceIdentity: "telegram:interactive",
      chatKey: "128",
      provider: "claude",
      reason: "wait",
      afterSeconds: 5,
    }, 1_000);
    completeOriginRun(db, "run-rec-3");
    claimDueRunContinuation(db, "run-rec-3", 6_000);

    // Run reconciliation
    reconcileRunContinuations(db, "telegram:interactive", 7_000);

    const conts = Object.fromEntries(listRunContinuations(db).map((c) => [c.id, c.state]));
    expect(conts["run-rec-1"]).toBe("claimed");
    expect(conts["run-rec-2"]).toBe("completed");
    expect(conts["run-rec-3"]).toBe("failed");
    db.close();
  });
});

describe("explicit one-shot future wake", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const base = {
    originRunId: "run-at",
    surfaceIdentity: "telegram:interactive",
    chatKey: "123",
    provider: "codex" as const,
    reason: "recheck release qualification",
  };

  it("keeps a wake beyond two hours pending until due, then dispatches exactly once", async () => {
    const { db } = setup();
    const dueAtMs = 1_000 + DAY;
    const wake = requestForActiveRun(db, { ...base, dueAtMs }, 1_000);
    expect(wake.dueAt).toBe(new Date(dueAtMs).toISOString());
    expect(Date.parse(wake.expiresAt)).toBeGreaterThan(dueAtMs);
    completeOriginRun(db, "run-at");
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, 1_000 + 3 * 60 * 60 * 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).toBe("pending");
    await scanRunContinuations(db, "telegram:interactive", dispatch, dueAtMs);
    await scanRunContinuations(db, "telegram:interactive", dispatch, dueAtMs + 1_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db)[0].state).toBe("completed");
    db.close();
  });

  it("survives a restart before the due instant and still fires once afterwards", async () => {
    const { db, path } = setup();
    const dueAtMs = 1_000 + 2 * DAY;
    requestForActiveRun(db, { ...base, dueAtMs }, 1_000);
    completeOriginRun(db, "run-at");
    db.close();
    const reopened = openDb(path, { serviceId: "run-continuation-test-reopen", runId: "test-process-2" });
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, dueAtMs - 1);
    expect(dispatch).not.toHaveBeenCalled();
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, dueAtMs + 60_000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    reopened.close();
  });

  it("expires a wake that stays undelivered for the admission grace after it was due", async () => {
    const { db } = setup();
    const dueAtMs = 1_000 + DAY;
    requestForActiveRun(db, { ...base, dueAtMs }, 1_000);
    const dispatch = vi.fn(async () => undefined);
    await scanRunContinuations(db, "telegram:interactive", dispatch, dueAtMs + 2 * 60 * 60 * 1_000);
    expect(dispatch).not.toHaveBeenCalled();
    expect(listRunContinuations(db)[0].state).toBe("expired");
    db.close();
  });

  it("bounds the wake to between five seconds and seven days from the request", () => {
    const { db } = setup();
    const now = 1_000_000;
    expect(() => requestRunContinuation(db, { ...base, dueAtMs: now + 4_000 }, now)).toThrow(/between/);
    expect(() => requestRunContinuation(db, { ...base, dueAtMs: now - 60_000 }, now)).toThrow(/between/);
    expect(() => requestRunContinuation(db, { ...base, dueAtMs: now + 7 * DAY + 1_000 }, now)).toThrow(/between/);
    expect(() => requestRunContinuation(db, { ...base, dueAtMs: now + 5_000.5 }, now)).toThrow(/between/);
    expect(() => requestRunContinuation(db, { ...base, dueAtMs: now + 60_000, afterSeconds: 60 }, now)).toThrow(/either/);
    expect(() => requestRunContinuation(db, { ...base }, now)).toThrow(/either/);
    db.close();
  });

  it("leaves ordinary short continuations and their two-hour expiry unchanged", () => {
    const { db } = setup();
    const wake = requestForActiveRun(db, { ...base, afterSeconds: 60 }, 1_000);
    expect(wake.dueAt).toBe(new Date(61_000).toISOString());
    expect(wake.expiresAt).toBe(new Date(1_000 + 2 * 60 * 60 * 1_000).toISOString());
    db.close();
  });
});
