import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import {
  buildDiscordRunContinuationTurn,
  buildTelegramRunContinuationTurn,
  cancelPendingRunContinuation,
  claimDueRunContinuation,
  listRunContinuations,
  requestRunContinuation,
  scanRunContinuations,
  settleRunContinuation,
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
  db.insertRun(input.originRunId, input.chatKey, input.provider);
  return requestRunContinuation(db, input, nowMs);
}

function completeOriginRun(db: ReturnType<typeof openDb>, runId: string): void {
  expect(db.updateRunCompleted(runId, "done", `session-${runId}`)).toBe(true);
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
    completeOriginRun(db, "run-4");
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
    expect(turn.delivery).toEqual({ chatId: -100, chatType: "supergroup" });
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
