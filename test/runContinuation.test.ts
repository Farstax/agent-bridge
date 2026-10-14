import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
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
  reconcileRunContinuations,
  linkRunContinuationRun,
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
