import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine, type ExecutionOutcome } from "../src/engine.js";
import { buildCliKeyboard, buildCliStatusText, isCliCommandText } from "../src/interactiveBot.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

const SURFACE = "telegram:interactive";
const RECOVERY_CHAT_KEY = "100";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function makeClient(updates?: unknown[]) {
  const pendingPoll = new Promise(() => {});
  const getUpdates = vi.fn();
  if (updates) {
    getUpdates.mockResolvedValueOnce({ ok: true, result: updates });
    getUpdates.mockImplementation(() => pendingPoll);
  } else {
    getUpdates.mockImplementation(() => pendingPoll);
  }
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    getUpdates,
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function makeEngine(db: BridgeDb, client: any) {
  return new BridgeEngine({
    kind: "codex",
    surfaceIdentity: SURFACE,
    botConfig: { command: "codex", modelPreference: ["gpt-5.6"] },
    allowedUserIds: new Set(["42"]),
    executionMode: "trusted",
    busyMessageMode: "queue",
    pollIntervalMs: 1,
  }, db, client, {});
}

function enqueueRecoveredTurn(db: BridgeDb) {
  db.enqueueMsg(SURFACE, RECOVERY_CHAT_KEY, {
    prompt: "recovered work",
    chatId: 100,
    chatType: "private",
    userId: 42,
  });
}

describe("startup queue recovery ingress liveness", () => {
  const dbs: BridgeDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try { db.close(); } catch {}
    }
    vi.restoreAllMocks();
  });

  it("returns from startup recovery while the claimed recovered lane remains exclusively owned", async () => {
    const db = openDb(":memory:");
    dbs.push(db);
    enqueueRecoveredTurn(db);
    const engine = makeEngine(db, makeClient());
    const started = deferred<void>();
    const release = deferred<ExecutionOutcome>();

    engine.setQueuedMessageHandler(async () => {
      started.resolve();
      return release.promise;
    });

    await expect(engine.recoverPendingQueues()).resolves.toBeUndefined();
    await started.promise;

    expect(db.pendingMsgCount(SURFACE, RECOVERY_CHAT_KEY)).toBe(1);
    expect(db.acquireLock(SURFACE, RECOVERY_CHAT_KEY)).toBeNull();

    release.resolve("committed");
    await vi.waitFor(() => expect(db.pendingMsgCount(SURFACE, RECOVERY_CHAT_KEY)).toBe(0));
  });

  it("starts BridgeEngine polling and dispatches another chat while recovered work is still running", async () => {
    const unrelatedUpdate = {
      update_id: 7,
      message: {
        message_id: 17,
        chat: { id: 200, type: "private" },
        from: { id: 42, first_name: "Test" },
        text: "unrelated chat",
      },
    };
    const db = openDb(":memory:");
    dbs.push(db);
    enqueueRecoveredTurn(db);
    const client = makeClient([unrelatedUpdate]);
    const engine = makeEngine(db, client);
    const recoveryStarted = deferred<void>();
    const release = deferred<ExecutionOutcome>();
    engine.setQueuedMessageHandler(async () => {
      recoveryStarted.resolve();
      return release.promise;
    });
    const handleUpdate = vi.spyOn(engine, "handleUpdate").mockResolvedValue(undefined);

    void engine.run();
    await recoveryStarted.promise;
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledWith(unrelatedUpdate, "200"));

    expect(client.getUpdates).toHaveBeenCalled();
    expect(db.acquireLock(SURFACE, RECOVERY_CHAT_KEY)).toBeNull();

    release.resolve("committed");
    await vi.waitFor(() => expect(db.pendingMsgCount(SURFACE, RECOVERY_CHAT_KEY)).toBe(0));
  });

  it("allows the unified startup sequence to answer /cli while a recovered lane is still running", async () => {
    const db = openDb(":memory:");
    dbs.push(db);
    enqueueRecoveredTurn(db);
    const client = makeClient();
    const engine = makeEngine(db, client);
    const recoveryStarted = deferred<void>();
    const release = deferred<ExecutionOutcome>();
    engine.setQueuedMessageHandler(async () => {
      recoveryStarted.resolve();
      return release.promise;
    });

    await engine.recoverPendingQueues();
    await recoveryStarted.promise;

    const rawText = "/cli";
    expect(isCliCommandText(rawText, "CrawlerInteractiveBot")).toBe(true);
    const available = new Set(["codex"] as const);
    await client.sendMessage({
      chat_id: 200,
      text: buildCliStatusText("codex", available),
      reply_markup: buildCliKeyboard("codex", available),
    });

    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      chat_id: 200,
      text: expect.stringContaining("Active CLI"),
    }));
    expect(db.acquireLock(SURFACE, RECOVERY_CHAT_KEY)).toBeNull();

    release.resolve("committed");
    await vi.waitFor(() => expect(db.pendingMsgCount(SURFACE, RECOVERY_CHAT_KEY)).toBe(0));
  });
});
