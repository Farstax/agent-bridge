import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { EventStore } from "../src/events/store.js";
import {
  getUserCliPreference,
  resolveUpdateChatKey,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import type { MessagingPlatform } from "../src/platform.js";
import type { BridgeConfig, TelegramUpdate } from "../src/types.js";

function fakePlatform(): MessagingPlatform {
  return {
    async getUpdates() { return { ok: true, result: [] }; },
    async sendMessage() { return { ok: true, result: { message_id: 1 } }; },
    async editMessageText() { return { ok: true, result: { message_id: 1 } }; },
    async sendChatAction() { return { ok: true, result: true }; },
    async answerCallbackQuery() { return { ok: true, result: true }; },
    async setMyCommands() { return { ok: true, result: true }; },
    async sendDocument() {},
    async sendPhoto() {},
    async getFilePath() { return ""; },
    async downloadFile() {},
  };
}

function fullConfig(allowedUserIds: ReadonlySet<string>): BridgeConfig {
  return {
    allowedUserIds,
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1,
    executionMode: "safe",
    busyMessageMode: "augment",
    dbPath: ":memory:",
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: ["default"] },
      claude: { token: undefined, command: "claude", modelPreference: ["default"] },
      antigravity: { token: undefined, command: "agy", modelPreference: ["default"] },
      grok: { token: undefined, command: "grok", modelPreference: ["default"] },
    },
  };
}

function resetUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: 1, type: "private" },
      from: { id: 7, first_name: "User" },
      text: "/reset",
    },
  };
}

function queueModeUpdate(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, first_name: "User" },
      data: "queue_mode:queue",
      message: {
        message_id: updateId,
        chat: { id: 1, type: "private" },
        from: { id: 7, first_name: "User" },
        text: "queue mode",
      },
    },
  };
}

function oldDiscordAlias(snowflake: string): string {
  return String(Number(BigInt(snowflake) % BigInt(Number.MAX_SAFE_INTEGER)));
}

describe("canonical conversation identity", () => {
  it("keeps colliding Discord Snowflakes isolated across Engine-owned durable state", async () => {
    const nativeA = "1";
    const nativeB = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(oldDiscordAlias(nativeA)).toBe(oldDiscordAlias(nativeB));

    const surface = "discord:interactive";
    const db = openDb(":memory:", { serviceId: "canonical-chat-key-test" });
    try {
      db.setSession(nativeA, "codex", "session-a");
      db.setSession(nativeB, "codex", "session-b");
      db.addConvTurn(nativeA, "user", "alpha marker", "codex");
      db.addConvTurn(nativeB, "user", "beta marker", "codex");
      setUserCliPreference(db, nativeA, "claude");
      setUserCliPreference(db, nativeB, "antigravity");

      const lockA = db.acquireLock(surface, nativeA);
      const lockB = db.acquireLock(surface, nativeB);
      expect(lockA).not.toBeNull();
      expect(lockB).not.toBeNull();
      db.unlock(lockA!);
      db.unlock(lockB!);

      db.enqueueMsg(surface, nativeA, {
        prompt: "queued-a",
        chatId: 1,
        chatType: "private",
        userId: 7,
      });
      db.enqueueMsg(surface, nativeB, {
        prompt: "queued-b",
        chatId: 1,
        chatType: "private",
        userId: 7,
      });

      const allowedUserIds = new Set(["7"]);
      const engine = new BridgeEngine({
        kind: "codex",
        surfaceIdentity: surface,
        botConfig: { command: "codex", modelPreference: ["default"] },
        allowedUserIds,
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1,
        fullConfig: fullConfig(allowedUserIds),
      }, db, fakePlatform());

      await engine.handleUpdate(resetUpdate(1), nativeB);

      expect(db.getSession(nativeB, "codex")).toBeNull();
      expect(db.getSession(nativeA, "codex")).toBe("session-a");
      expect(db.searchConvTurns(nativeB, "beta")).toEqual([]);
      expect(db.searchConvTurns(nativeA, "alpha").some((row) => row.text.includes("alpha marker"))).toBe(true);
      expect(db.pendingMsgCount(surface, nativeB)).toBe(0);
      expect(db.pendingMsgCount(surface, nativeA)).toBe(1);
      expect(getUserCliPreference(db, nativeA)).toBe("claude");
      expect(getUserCliPreference(db, nativeB)).toBe("antigravity");

      await engine.handleUpdate(queueModeUpdate(2), nativeB);
      expect(db.getSetting(busyMessageModeSettingKey(surface, nativeB))).toBe("queue");
      expect(db.getSetting(busyMessageModeSettingKey(surface, nativeA))).toBeNull();
    } finally {
      db.close();
    }
  });


  it("keeps retained turn search isolated when different surfaces share the same native chat id", () => {
    const db = openDb(":memory:", { serviceId: "canonical-turn-search-test" });
    try {
      db.addConvTurn("42", "user", "telegram marker", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "telegram-owner" });
      db.addConvTurn("42", "user", "discord marker", "codex", { surfaceIdentity: "discord:interactive", ownerKey: "discord-owner" });
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "42" }, "marker").filter((row) => row.is_match).map((row) => row.text)).toEqual(["telegram marker"]);
      expect(db.searchAuthorizedConvTurns({ scope: "conversation", surfaceIdentity: "discord:interactive", chatKey: "42" }, "marker").filter((row) => row.is_match).map((row) => row.text)).toEqual(["discord marker"]);
    } finally { db.close(); }
  });

  it("recovers a queued Discord conversation from its durable native key after database reopen", async () => {
    const dbPath = join(tmpdir(), `canonical-chat-key-${process.pid}-${Date.now()}.sqlite`);
    const surface = "discord:interactive";
    const nativeKey = "1234567890123456789";
    try {
      const first = openDb(dbPath, { serviceId: "canonical-queue-before-restart" });
      first.enqueueMsg(surface, nativeKey, {
        prompt: "recover me",
        chatId: 1,
        chatType: "private",
        userId: 7,
      });
      first.close();

      const second = openDb(dbPath, { serviceId: "canonical-queue-after-restart" });
      try {
        const recovered: Array<{ chatKey: string; chatId: string }> = [];
        const engine = new BridgeEngine({
          kind: "codex",
          surfaceIdentity: surface,
          botConfig: { command: "codex", modelPreference: ["default"] },
          allowedUserIds: new Set(["7"]),
          executionMode: "safe",
          busyMessageMode: "queue",
          pollIntervalMs: 1,
        }, second, fakePlatform());
        engine.setQueuedMessageHandler(async (message) => {
          recovered.push({ chatKey: message.chatKey, chatId: message.chatId });
          return "committed";
        });

        expect(await engine.recoverPendingQueue(nativeKey)).toBe(true);
        expect(recovered).toEqual([{ chatKey: nativeKey, chatId: "1.0" }]);
        expect(second.pendingMsgCount(surface, nativeKey)).toBe(0);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it("persists and reconciles the authoritative Run key instead of rebuilding delivery coordinates", async () => {
    const db = openDb(":memory:", { serviceId: "canonical-event-key-test" });
    try {
      const nativeKey = "1234567890123456789";
      const store = new EventStore(db);
      store.collect({
        type: "run.started",
        version: 1,
        id: "event-1",
        runId: "run-native",
        timestamp: new Date(0).toISOString(),
        bot: "claude",
        chatId: "1",
        threadId: "99",
        chatKey: nativeKey,
        model: null,
        command: "claude",
        cwd: "/tmp",
      });

      expect(db.getRun("run-native").chat_id).toBe(nativeKey);

      const destinations: string[] = [];
      await db.reconcileOrphanedRuns({
        nowMs: Date.now(),
        minAgeMs: 0,
        candidateRuns: [db.getRun("run-native")],
        processState: () => "absent",
        containmentState: () => "proven",
        onReconciled: (run) => { destinations.push(run.chat_id); },
      });
      expect(destinations).toEqual([nativeKey]);
    } finally {
      db.close();
    }
  });

  it("keeps Telegram private, group, and topic addressing unchanged", () => {
    const update = (chatId: number, chatType: string, threadId?: number): TelegramUpdate => ({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: chatId, type: chatType },
        from: { id: 7, first_name: "User" },
        ...(threadId == null ? {} : { message_thread_id: threadId }),
        text: "hello",
      },
    });

    expect(resolveUpdateChatKey(update(42, "private"))).toBe("42");
    expect(resolveUpdateChatKey(update(-1004366290625, "supergroup"))).toBe("-1004366290625");
    expect(resolveUpdateChatKey(update(-1004366290625, "supergroup", 1458))).toBe("-1004366290625:1458");
  });
});
