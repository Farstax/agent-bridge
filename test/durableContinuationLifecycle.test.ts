import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ContinuationFns } from "../src/engine.js";
import { recoverCancelledContinuationContainment } from "../src/continuationRecovery.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";
import type { TelegramMessage } from "../src/types.js";

function makeMessage(text: string, messageId: number): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeOutput(text: string, sessionId: string, background = false): string {
  return [
    ...(background ? [JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: `tool-${text}`,
        name: "Bash",
        input: { command: "npm test", run_in_background: true },
      }] },
    })] : []),
    JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId }),
  ].join("\n");
}

function readClaudeInput(args: string[], options: any): string {
  if (!options.stdin) return String(args.at(-1) ?? "");
  const parsed = JSON.parse(String(options.stdin));
  return typeof parsed.message.content === "string"
    ? parsed.message.content
    : parsed.message.content.map((block: any) => block.text ?? "").join("\n");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("durable async continuation lifecycle", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `durable-continuation-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath, { serviceId: "test-service", runId: "test-process", lockLeaseMs: 100 });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CONTINUATION_MAX_RESUMPTIONS;
    delete process.env.CONTINUATION_MAX_LIFETIME_MS;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("persists an async wait before waking and resumes through the same durable run and provider session", async () => {
    let processState: "live" | "absent" = "live";
    const gate = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => processState === "live"),
      getRunOwnedProcessState: vi.fn(() => processState),
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => { await gate.promise; processState = "absent"; }),
      now: vi.fn(() => Date.now()),
    };
    const runIds: string[] = [];
    const prompts: string[] = [];
    const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      runIds.push(options.eventContext.runId);
      prompts.push(readClaudeInput(_args, options));
      return {
        text: runCliAsync.mock.calls.length === 1
          ? claudeOutput("Background work is running.", "session-async-261", true)
          : claudeOutput("Background work finished.", "session-async-261"),
      };
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    const repo = new ContinuationRepository(db.raw);

    const execution = engine.handleMessages([makeMessage("run the tests", 1)]);
    await waitUntil(() => runIds.length === 1 && repo.listActive("test", "claude").length === 1, "durable waiting checkpoint");

    const waiting = repo.listActive("test", "claude")[0];
    expect(waiting.state).toBe("waiting");
    expect(waiting.sessionId).toBe("session-async-261");
    expect(waiting.executionMode).toBe("async");
    expect(waiting.runId).toBe(runIds[0]);

    gate.resolve();
    await execution;

    expect(runCliAsync).toHaveBeenCalledTimes(2);
    expect(new Set(runIds).size).toBe(1);
    expect(prompts[1]).toContain("background work");
    const secondArgs = runCliAsync.mock.calls[1][1] as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs[secondArgs.indexOf("--resume") + 1]).toBe("session-async-261");
    expect(repo.get(runIds[0])?.state).toBe("completed");
    expect(client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text))).toEqual([
      "Background work is running.",
      "Background work finished.",
    ]);
  });

  it("fails closed without partially reclaiming a multi-row continuation", async () => {
    const runId = "multi-row-reclaim-recovery-379";
    db.insertRun(runId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "first", chatId: 100, chatType: "private", attachments: ["A"] });
    db.enqueueMsg("test", "100", { prompt: "second", chatId: 100, chatType: "private", attachments: ["B"] });
    const rows = db.dequeueMsgs("test", "100");
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId, surface: "test", chatKey: "100", chatId: 100, threadId: null, bot: "claude", sessionId: "session-379",
      prompt: "recover", chatType: "private", userId: 42, attachments: ["A", "B"], executionMode: "async",
      triggerKind: "run-owned-background-process", triggerId: runId, resumptionCount: 0, pendingIds: rows.map((row) => row.id),
      startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    db.raw.prepare("DELETE FROM pending_messages WHERE id = ?").run(rows[1].id);
    const runCliAsync = vi.fn();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, makeMockClient(), { runCliAsync }, { getRunOwnedProcessState: () => "absent", sleep: vi.fn(async () => {}) });

    await engine.recoverContinuations();

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(repo.get(runId)).toEqual(expect.objectContaining({ state: "ambiguous" }));
    expect(db.raw.prepare("SELECT state, claim_run_id AS runId, claim_acquisition_id AS acquisitionId FROM pending_messages WHERE id = ?").get(rows[0].id)).toEqual({
      state: "queued", runId: null, acquisitionId: null,
    });
  });

  it("persists the waiting checkpoint before delivering the intermediate response", async () => {
    let processState: "live" | "absent" = "live";
    const deliveryGate = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => processState === "live"),
      getRunOwnedProcessState: vi.fn(() => processState),
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => { processState = "absent"; }),
      now: vi.fn(() => Date.now()),
    };
    const runIds: string[] = [];
    const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      runIds.push(options.eventContext.runId);
      return {
        text: runCliAsync.mock.calls.length === 1
          ? claudeOutput("Background work is running.", "session-before-delivery-261", true)
          : claudeOutput("Background work finished.", "session-before-delivery-261"),
      };
    });
    const client = makeMockClient();
    client.sendMessage.mockImplementation(async () => {
      if (client.sendMessage.mock.calls.length === 1) await deliveryGate.promise;
      return { ok: true, result: { message_id: 1 } };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    const repo = new ContinuationRepository(db.raw);

    const execution = engine.handleMessages([makeMessage("run the tests", 2)]);
    await waitUntil(() => client.sendMessage.mock.calls.length === 1 && runIds.length === 1, "intermediate delivery start");
    const checkpointAtDeliveryStart = repo.get(runIds[0]);

    deliveryGate.resolve();
    await execution;

    expect(checkpointAtDeliveryStart?.state).toBe("waiting");
    expect(checkpointAtDeliveryStart?.sessionId).toBe("session-before-delivery-261");
    expect(checkpointAtDeliveryStart?.deliveryState).toBe("pending");
    expect(checkpointAtDeliveryStart?.pendingAttempt).toEqual(expect.objectContaining({
      prompt: "run the tests",
      isInitialResult: true,
      result: expect.objectContaining({
        text: "Background work is running.",
        sessionId: "session-before-delivery-261",
      }),
    }));
    expect(repo.get(runIds[0])?.deliveryState).toBe("delivered");
    expect(repo.get(runIds[0])?.pendingAttempt).toBeUndefined();
  });

  it("recovers a persisted waiting turn once, preserving the durable run id", async () => {
    const durableRunId = "durable-run-261";
    db.insertRun(durableRunId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-restart-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("Recovered work complete.", "session-restart-261") });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    await engine.recoverContinuations();
    await waitUntil(() => repo.get(durableRunId)?.state === "completed", "recovered continuation completion");
    await engine.recoverContinuations();
    await nextTurn();

    expect(runCliAsync).toHaveBeenCalledOnce();
    const options = runCliAsync.mock.calls[0][3] as any;
    expect(options.eventContext.runId).toBe(durableRunId);
    expect(repo.get(durableRunId)?.state).toBe("completed");
    expect(db.getRun(durableRunId)?.status).toBe("done");
  });

  it("closes the user-visible loop when the resumed provider continuation fails", async () => {
    const durableRunId = "provider-continuation-failure-289";
    db.insertRun(durableRunId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-failure-289",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const client = makeMockClient();
    const runCliAsync = vi.fn().mockRejectedValue(new Error("provider session lost while inspecting background work"));
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.recoverContinuations();
    await waitUntil(() => db.getRun(durableRunId)?.status === "failed", "failed continuation closure");

    expect(runCliAsync).toHaveBeenCalledOnce();
    expect(db.getRun(durableRunId)?.status).toBe("failed");
    expect(client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text))).toEqual([
      expect.stringContaining("provider session lost while inspecting background work"),
    ]);
  });

  it("delivers and commits a checkpointed response before invoking the provider after restart", async () => {
    const durableRunId = "delivery-pending-run-261";
    db.insertRun(durableRunId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-delivery-pending-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryState: "pending",
      pendingAttempt: {
        prompt: "run the tests",
        isInitialResult: true,
        result: {
          text: "Background work is running.",
          sessionId: "session-delivery-pending-261",
          memoryCandidates: [],
          continuationHint: "background-process",
          continuationProcessObserved: true,
        },
      },
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const client = makeMockClient();
    const deliveryCountAtResume: number[] = [];
    const runCliAsync = vi.fn().mockImplementation(async () => {
      deliveryCountAtResume.push(client.sendMessage.mock.calls.length);
      return { text: claudeOutput("Background work finished.", "session-delivery-pending-261") };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.recoverContinuations();
    await waitUntil(() => repo.get(durableRunId)?.state === "completed", "delivery-pending continuation completion");

    expect(deliveryCountAtResume).toEqual([1]);
    expect(client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text))).toEqual([
      "Background work is running.",
      "Background work finished.",
    ]);
    expect(db.raw.prepare("SELECT role, text FROM conversation_turns WHERE chat_key = ? ORDER BY id").all("100")).toEqual([
      expect.objectContaining({ role: "user", text: expect.stringContaining("run the tests") }),
      expect.objectContaining({ role: "assistant", text: expect.stringContaining("Background work is running.") }),
      expect.objectContaining({ role: "assistant", text: expect.stringContaining("Background work finished.") }),
    ]);
  });

  it("keeps the original queued turn pending when recovered response delivery fails", async () => {
    const durableRunId = "delivery-retry-run-261";
    db.insertRun(durableRunId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "run the tests", chatId: 100, chatType: "private" });
    const pendingId = db.dequeueMsgs("test", "100")[0].id;
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-delivery-retry-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [pendingId],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryState: "pending",
      pendingAttempt: {
        prompt: "run the tests",
        isInitialResult: true,
        result: {
          text: "Background work is running.",
          sessionId: "session-delivery-retry-261",
          memoryCandidates: [],
          continuationHint: "background-process",
          continuationProcessObserved: true,
        },
      },
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const client = makeMockClient();
    client.sendMessage.mockRejectedValue(new Error("telegram unavailable"));
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("must not run", "session-delivery-retry-261") });
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.recoverContinuations();
    await waitUntil(() => !db.raw.prepare("SELECT 1 FROM execution_locks WHERE surface = ? AND chat_key = ?").get("test", "100"), "failed recovery unlock");

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(repo.get(durableRunId)).toEqual(expect.objectContaining({ state: "waiting", deliveryState: "pending" }));
    expect(db.raw.prepare("SELECT state FROM pending_messages WHERE id = ?").get(pendingId)).toEqual({ state: "queued" });
  });

  it("does not let scheduled startup queue recovery replay a turn with an active continuation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const durableRunId = "delivery-startup-race-261";
    db.insertRun(durableRunId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "run the tests", chatId: 100, chatType: "private" });
    const pendingId = db.dequeueMsgs("test", "100")[0].id;
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-delivery-startup-race-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [pendingId],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryState: "pending",
      pendingAttempt: {
        prompt: "run the tests",
        isInitialResult: true,
        result: {
          text: "Background work is running.",
          sessionId: "session-delivery-startup-race-261",
          memoryCandidates: [],
          continuationHint: "background-process",
          continuationProcessObserved: true,
        },
      },
    });

    const deliveryGate = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const client = makeMockClient();
    client.sendMessage.mockImplementationOnce(async () => {
      await deliveryGate.promise;
      throw new Error("telegram unavailable");
    });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("must not run", "session-delivery-startup-race-261") });
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    const recoveredQueuePrompts: string[] = [];
    engine.setQueuedMessageHandler(async (queued) => {
      recoveredQueuePrompts.push(queued.prompt);
      return "committed";
    });

    await engine.recoverContinuations();
    await engine.recoverPendingQueues();
    deliveryGate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(db.lockHeartbeatMs + 1);

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(recoveredQueuePrompts).toEqual([]);
    expect(repo.get(durableRunId)).toEqual(expect.objectContaining({ state: "waiting", deliveryState: "pending" }));
    expect(db.raw.prepare("SELECT state FROM pending_messages WHERE id = ?").get(pendingId)).toEqual({ state: "queued" });
  });

  it("does not drain the original queued turn when recovered waiting fails ambiguously", async () => {
    const durableRunId = "provider-recovery-failure-261";
    db.insertRun(durableRunId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "run the tests", chatId: 100, chatType: "private" });
    const pendingId = db.dequeueMsgs("test", "100")[0].id;
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-provider-recovery-failure-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [pendingId],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => true),
      getRunOwnedProcessState: vi.fn(() => "live"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => { throw new Error("process inspection unavailable"); }),
      now: vi.fn(() => Date.now()),
    };
    const recoveredQueuePrompts: string[] = [];
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, makeMockClient(), { runCliAsync: vi.fn().mockResolvedValue({ text: claudeOutput("must not run", "session-provider-recovery-failure-261") }) }, continuation);
    engine.setQueuedMessageHandler(async (queued) => {
      recoveredQueuePrompts.push(queued.prompt);
      return "committed";
    });

    await engine.recoverContinuations();
    await waitUntil(() => !db.raw.prepare("SELECT 1 FROM execution_locks WHERE surface = ? AND chat_key = ?").get("test", "100"), "provider recovery failure unlock");

    expect(recoveredQueuePrompts).toEqual([]);
    expect(repo.get(durableRunId)).toEqual(expect.objectContaining({ state: "ambiguous" }));
    expect(db.raw.prepare("SELECT state FROM pending_messages WHERE id = ?").get(pendingId)).toEqual({ state: "queued" });
  });

  it("queues a new user message without replaying pending delivery after recovery failure", async () => {
    const durableRunId = "delivery-admission-race-261";
    db.insertRun(durableRunId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "run the tests", chatId: 100, chatType: "private" });
    const pendingId = db.dequeueMsgs("test", "100")[0].id;
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-delivery-admission-race-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [pendingId],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryState: "pending",
      pendingAttempt: {
        prompt: "run the tests",
        isInitialResult: true,
        result: {
          text: "Background work is running.",
          sessionId: "session-delivery-admission-race-261",
          memoryCandidates: [],
          continuationHint: "background-process",
          continuationProcessObserved: true,
        },
      },
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const client = makeMockClient();
    client.sendMessage.mockRejectedValueOnce(new Error("telegram unavailable"));
    const recoveredQueuePrompts: string[] = [];
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("must not run", "session-delivery-admission-race-261") });
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", busyMessageMode: "queue", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    engine.setQueuedMessageHandler(async (queued) => {
      recoveredQueuePrompts.push(queued.prompt);
      return "committed";
    });

    await engine.recoverContinuations();
    await waitUntil(() => !db.raw.prepare("SELECT 1 FROM execution_locks WHERE surface = ? AND chat_key = ?").get("test", "100"), "failed delivery unlock before admission");
    await engine.handleMessages([makeMessage("new instruction", 4)]);

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(recoveredQueuePrompts).toEqual([]);
    expect(repo.get(durableRunId)).toEqual(expect.objectContaining({ state: "waiting", deliveryState: "pending" }));
    expect(db.raw.prepare("SELECT prompt, state FROM pending_messages WHERE surface = ? AND chat_key = ? ORDER BY id").all("test", "100")).toEqual([
      { prompt: "run the tests", state: "queued" },
      { prompt: "new instruction", state: "queued" },
    ]);
  });

  it("contains a cancelled durable continuation after restart without replaying the provider", async () => {
    const durableRunId = "cancelled-run-261";
    const staging = join(tmpdir(), "bridge-continuation-attachments-cancelled-run-261");
    const attachment = join(staging, "attachment.png");
    mkdirSync(staging, { recursive: true });
    writeFileSync(attachment, "orphaned staging");
    db.insertRun(durableRunId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-cancelled-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      attachments: [attachment],
    });
    repo.markCancelled(durableRunId, "stop");

    let processState: "live" | "absent" = "live";
    const fns = {
      getRunOwnedProcessState: vi.fn(() => processState),
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => {}),
    };

    await recoverCancelledContinuationContainment(db, repo, fns, 0);

    expect(fns.killRunOwnedDescendants).toHaveBeenCalledWith(durableRunId);
    expect(repo.get(durableRunId)?.containedAt).toBeTruthy();
    expect(repo.hasActiveRun(durableRunId)).toBe(false);
    expect(db.getRun(durableRunId)?.status).toBe("cancelled");
    expect(() => readFileSync(attachment)).toThrow();
    rmSync(staging, { recursive: true, force: true });
  });

  it("replays cancellation finalization after a crash before terminal commit", async () => {
    const runId = "cancel-finalization-crash";
    const staging = join(tmpdir(), `bridge-continuation-attachments-${runId}`);
    const attachment = join(staging, "attachment.png");
    mkdirSync(staging, { recursive: true });
    writeFileSync(attachment, "orphan");
    db.insertRun(runId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({ runId, surface: "test", chatKey: "100", chatId: 100, threadId: null, bot: "claude", sessionId: "s", prompt: "p", chatType: "private", executionMode: "async", triggerKind: "run-owned-background-process", triggerId: runId, resumptionCount: 0, pendingIds: [], startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), attachments: [attachment] } as any);
    repo.markCancelled(runId, "stop");
    vi.spyOn(db, "updateRunCancelled").mockImplementation((id, reason) => { throw new Error("crash before terminal finalization"); });
    const fns = { getRunOwnedProcessState: vi.fn(() => "absent" as const), killRunOwnedDescendants: vi.fn(async () => {}), sleep: vi.fn(async () => {}) };
    await expect(recoverCancelledContinuationContainment(db, repo, fns, 0)).rejects.toThrow("crash before terminal finalization");
    vi.restoreAllMocks();
    await recoverCancelledContinuationContainment(db, repo, fns, 0);
    expect(db.getRun(runId)?.status).toBe("cancelled");
    expect(() => readFileSync(attachment)).toThrow();
    rmSync(staging, { recursive: true, force: true });
  });

  it("replays cancellation finalization without deleting pending-owned staging", async () => {
    const runId = "cancel-finalization-pending-owner";
    const staging = join(tmpdir(), `bridge-continuation-attachments-${runId}`);
    const attachment = join(staging, "attachment.png");
    mkdirSync(staging, { recursive: true });
    writeFileSync(attachment, "owned");
    db.insertRun(runId, "100", "claude");
    db.enqueueMsg("test", "100", { prompt: "retry", chatId: 100, chatType: "private", attachments: [attachment] });
    const handle = db.acquireLock("test", "100");
    const row = db.claimNextPendingMsg(handle!);
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({ runId, surface: "test", chatKey: "100", chatId: 100, threadId: null, bot: "claude", sessionId: "s", prompt: "p", chatType: "private", executionMode: "async", triggerKind: "run-owned-background-process", triggerId: runId, resumptionCount: 0, pendingIds: [row!.id], startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), attachments: [attachment] } as any);
    repo.markCancelled(runId, "stop");
    vi.spyOn(db, "updateRunCancelled").mockImplementation(() => { throw new Error("crash before terminal finalization"); });
    const fns = { getRunOwnedProcessState: vi.fn(() => "absent" as const), killRunOwnedDescendants: vi.fn(async () => {}), sleep: vi.fn(async () => {}) };
    await expect(recoverCancelledContinuationContainment(db, repo, fns, 0)).rejects.toThrow("crash before terminal finalization");
    vi.restoreAllMocks();
    await recoverCancelledContinuationContainment(db, repo, fns, 0);
    expect(readFileSync(attachment, "utf8")).toBe("owned");
    db.releasePendingClaim(handle!, row!.id);
    db.completePendingMsg(handle!, row!.id);
    rmSync(staging, { recursive: true, force: true });
    db.close();
  });

  it("keeps continuation detection when a Claude model fallback launches background work", async () => {
    let processState: "live" | "absent" = "live";
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => processState === "live"),
      getRunOwnedProcessState: vi.fn(() => processState),
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => { processState = "absent"; }),
      now: vi.fn(() => Date.now()),
    };
    const runIds: string[] = [];
    const models: string[] = [];
    const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, args: string[], _cwd: string, options: any) => {
      runIds.push(options.eventContext.runId);
      const modelIndex = args.indexOf("--model");
      models.push(modelIndex >= 0 ? args[modelIndex + 1] : "");
      if (runCliAsync.mock.calls.length === 1) throw new Error("rate limit");
      if (runCliAsync.mock.calls.length === 2) {
        return { text: claudeOutput("Fallback background work is running.", "session-fallback-261", true) };
      }
      return { text: claudeOutput("Fallback background work finished.", "session-fallback-261") };
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: ["primary", "fallback"] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.handleMessages([makeMessage("run fallback work", 3)]);

    expect(runCliAsync).toHaveBeenCalledTimes(3);
    expect(models.slice(0, 2)).toEqual(["primary", "fallback"]);
    expect(new Set(runIds).size).toBe(1);
    expect(client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text))).toEqual([
      expect.stringContaining("Fallback background work is running."),
      "Fallback background work finished.",
    ]);
  });
});
