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

    const claimed = claimDueRunContinuation(db, continuation.id, 6_000);
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
});
