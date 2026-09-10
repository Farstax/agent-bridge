import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

const SURFACE = "telegram:interactive";
const CHAT_KEY = "100";
const START = Date.parse("2026-08-07T18:58:00.000Z");

function makeMockClient() {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("startup queue recovery", () => {
  const dbs: BridgeDb[] = [];
  const paths: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const db of dbs.splice(0)) {
      try { db.close(); } catch {}
    }
    for (const path of paths.splice(0)) {
      try { rmSync(path); } catch {}
      try { rmSync(`${path}-wal`); } catch {}
      try { rmSync(`${path}-shm`); } catch {}
    }
  });

  it("retries a pending lane after the previous process lease expires", async () => {
    vi.useFakeTimers();
    let now = START;
    const dbPath = join(tmpdir(), `queue-startup-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    paths.push(dbPath);

    const previous = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "old-process-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    dbs.push(previous);

    const oldHandle = previous.acquireLock(SURFACE, CHAT_KEY);
    expect(oldHandle).not.toBeNull();
    previous.enqueueMsg(SURFACE, CHAT_KEY, {
      prompt: "claimed before reboot",
      chatId: 100,
      chatType: "private",
    });
    previous.enqueueMsg(SURFACE, CHAT_KEY, {
      prompt: "queued after reboot",
      chatId: 100,
      chatType: "private",
    });
    expect(previous.claimNextPendingMsg(oldHandle!)?.prompt).toBe("claimed before reboot");
    previous.close();
    dbs.splice(dbs.indexOf(previous), 1);

    const current = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "new-process-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    dbs.push(current);

    const handled: string[] = [];
    const engine = new BridgeEngine({
      kind: "claude",
      surfaceIdentity: SURFACE,
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "queue",
      pollIntervalMs: 1000,
    }, current, makeMockClient(), {});
    engine.setQueuedMessageHandler(async (queued) => {
      handled.push(queued.prompt);
      return "committed";
    });

    await engine.recoverPendingQueues();
    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);

    now = START + current.lockHeartbeatMs + 1;
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);
    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);

    now = START + (current.lockHeartbeatMs * 2) + 1;
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);
    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);

    now = START + 90_001;
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(handled).toEqual(["claimed before reboot", "queued after reboot"]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0);
  });

  it("preserves string surface coordinates losslessly across restart", () => {
    const surface = "discord:interactive";
    const chatKey = "1234567890123456789";
    const chatId = "1234567890123456789";
    const threadId = "2234567890123456789";
    const userId = "3234567890123456789";
    const dbPath = join(tmpdir(), `queue-surface-id-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    paths.push(dbPath);

    const previous = openDb(dbPath, {
      serviceId: surface,
      runId: "old-process-generation",
    });
    previous.enqueueMsg(surface, chatKey, {
      prompt: "snowflake-sized coordinates",
      chatId,
      threadId,
      chatType: "private",
      userId,
    });
    previous.close();

    const current = openDb(dbPath, {
      serviceId: surface,
      runId: "new-process-generation",
    });
    dbs.push(current);

    expect(current.dequeueMsgs(surface, chatKey)[0]).toMatchObject({ chatId, threadId, userId });
    const handle = current.acquireLock(surface, chatKey);
    expect(handle).not.toBeNull();
    expect(current.claimNextPendingMsg(handle!)).toMatchObject({ chatId, threadId, userId });
  });

  it("does not steal a lane while the previous owner keeps its lease live", async () => {
    vi.useFakeTimers();
    let now = START;
    const dbPath = join(tmpdir(), `queue-startup-live-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    paths.push(dbPath);

    const previous = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "live-process-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    dbs.push(previous);
    const oldHandle = previous.acquireLock(SURFACE, CHAT_KEY);
    expect(oldHandle).not.toBeNull();
    previous.enqueueMsg(SURFACE, CHAT_KEY, {
      prompt: "still owned",
      chatId: 100,
      chatType: "private",
    });

    const current = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "new-process-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    dbs.push(current);
    const handled: string[] = [];
    const engine = new BridgeEngine({
      kind: "claude",
      surfaceIdentity: SURFACE,
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "queue",
      pollIntervalMs: 1000,
    }, current, makeMockClient(), {});
    engine.setQueuedMessageHandler(async (queued) => {
      handled.push(queued.prompt);
      return "committed";
    });

    await engine.recoverPendingQueues();
    now = START + current.lockHeartbeatMs;
    expect(previous.heartbeatLock(oldHandle!)).toBe(true);
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(1);
  });

  it("returns from startup recovery while recovered work retains exclusive lane ownership", async () => {
    const db = openDb(":memory:");
    dbs.push(db);
    db.enqueueMsg(SURFACE, CHAT_KEY, {
      prompt: "recovered work",
      chatId: 100,
      chatType: "private",
      userId: 42,
    });
    const engine = new BridgeEngine({
      kind: "codex",
      surfaceIdentity: SURFACE,
      botConfig: { command: "codex", modelPreference: ["gpt-5.6"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "trusted",
      busyMessageMode: "queue",
      pollIntervalMs: 1,
    }, db, makeMockClient(), {});
    const started = deferred<void>();
    const release = deferred<"committed">();

    engine.setQueuedMessageHandler(async () => {
      started.resolve();
      return release.promise;
    });

    await expect(engine.recoverPendingQueues()).resolves.toBeUndefined();
    await started.promise;

    expect(db.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(1);
    expect(db.acquireLock(SURFACE, CHAT_KEY)).toBeNull();

    release.resolve("committed");
    await vi.waitFor(() => expect(db.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0));
  });

  it("starts polling and dispatches an unrelated chat while recovered work remains open", async () => {
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
    db.enqueueMsg(SURFACE, CHAT_KEY, {
      prompt: "recovered work",
      chatId: 100,
      chatType: "private",
      userId: 42,
    });
    const client = makeMockClient();
    const pendingPoll = new Promise(() => {});
    client.getUpdates.mockResolvedValueOnce({ ok: true, result: [unrelatedUpdate] });
    client.getUpdates.mockImplementation(() => pendingPoll);
    const engine = new BridgeEngine({
      kind: "codex",
      surfaceIdentity: SURFACE,
      botConfig: { command: "codex", modelPreference: ["gpt-5.6"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "trusted",
      busyMessageMode: "queue",
      pollIntervalMs: 1,
    }, db, client, {});
    const recoveryStarted = deferred<void>();
    const release = deferred<"committed">();
    engine.setQueuedMessageHandler(async () => {
      recoveryStarted.resolve();
      return release.promise;
    });
    const handleUpdate = vi.spyOn(engine, "handleUpdate").mockResolvedValue(undefined);

    void engine.run();
    await recoveryStarted.promise;
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledWith(unrelatedUpdate, "200"));

    expect(client.getUpdates).toHaveBeenCalled();
    expect(db.acquireLock(SURFACE, CHAT_KEY)).toBeNull();

    release.resolve("committed");
    await vi.waitFor(() => expect(db.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0));
  });
});
