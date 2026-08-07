import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";

const SURFACE = "telegram:interactive";
const CHAT_KEY = "100";
const START = Date.parse("2026-08-07T18:58:00.000Z");

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
      asyncEnabled: false,
      pollIntervalMs: 1000,
    }, current, makeMockClient(), {});
    engine.setQueuedMessageHandler(async (queued) => {
      handled.push(queued.prompt);
      return "committed";
    });

    await engine.recoverPendingQueues();
    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);

    now = START + 90_001;
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(handled).toEqual(["claimed before reboot", "queued after reboot"]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0);
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
      asyncEnabled: false,
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
});
