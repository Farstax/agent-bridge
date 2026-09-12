import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

const SURFACE = "telegram:interactive";
const CHAT_KEY = "100";
const START = Date.parse("2026-09-12T08:00:00.000Z");

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

function message(messageId: number, text: string) {
  return {
    message_id: messageId,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Operator" },
    text,
  } as any;
}

function update(messageId: number, text: string) {
  return { update_id: messageId, message: message(messageId, text) } as any;
}

function makeEngine(db: BridgeDb) {
  return new BridgeEngine({
    kind: "claude",
    surfaceIdentity: SURFACE,
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    busyMessageMode: "queue",
    pollIntervalMs: 1000,
  }, db, makeMockClient(), {});
}

describe("durable queue recovery", () => {
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

  function openForeignLeasePair(name: string) {
    let now = START;
    const dbPath = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    paths.push(dbPath);
    const previous = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "foreign-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    const current = openDb(dbPath, {
      serviceId: SURFACE,
      runId: "current-generation",
      lockLeaseMs: 90_000,
      clock: () => now,
    });
    dbs.push(previous, current);
    expect(previous.acquireLock(SURFACE, CHAT_KEY)).not.toBeNull();
    return { current, setNow: (value: number) => { now = value; } };
  }

  it("recovers an ordinary queued message after an abandoned foreign lease expires without new ingress", async () => {
    vi.useFakeTimers();
    const { current, setNow } = openForeignLeasePair("queue-durable-abandoned");
    const engine = makeEngine(current);
    const handled: string[] = [];
    engine.setQueuedMessageHandler(async (queued) => {
      handled.push(queued.prompt);
      return "committed";
    });

    await engine.handleMessages([message(1, "queued behind foreign owner")], CHAT_KEY);

    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(1);

    setNow(START + 90_001);
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(handled).toEqual(["queued behind foreign owner"]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0);
  });

  it("deduplicates recovery polling across engines sharing the runtime", async () => {
    vi.useFakeTimers();
    const { current, setNow } = openForeignLeasePair("queue-durable-dedupe");
    const first = makeEngine(current);
    const second = makeEngine(current);

    await first.handleMessages([message(1, "first queued")], CHAT_KEY);
    await second.handleMessages([message(2, "second queued")], CHAT_KEY);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);

    const acquire = vi.spyOn(current, "acquireLock");
    acquire.mockClear();
    setNow(START + current.lockHeartbeatMs + 1);
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(2);
  });

  it("does not revive queued work discarded by stop while recovery is armed", async () => {
    vi.useFakeTimers();
    const { current, setNow } = openForeignLeasePair("queue-durable-stop");
    const engine = makeEngine(current);
    const handled: string[] = [];
    engine.setQueuedMessageHandler(async (queued) => {
      handled.push(queued.prompt);
      return "committed";
    });

    await engine.handleMessages([message(1, "discard me")], CHAT_KEY);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(1);

    await engine.handleUpdate(update(2, "/stop"), CHAT_KEY);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0);

    setNow(START + 90_001);
    await vi.advanceTimersByTimeAsync(current.lockHeartbeatMs + 1);

    expect(handled).toEqual([]);
    expect(current.pendingMsgCount(SURFACE, CHAT_KEY)).toBe(0);
  });
});
