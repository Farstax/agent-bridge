import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { EventStore } from "../src/events/store.js";
import { resolveUpdateChatKey } from "../src/interactiveBot.js";
import type { MessagingPlatform } from "../src/platform.js";
import type { TelegramUpdate } from "../src/types.js";

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

describe("canonical conversation identity", () => {
  it("uses the surface-provided key even when two Discord channels share the old numeric alias", async () => {
    const db = openDb(":memory:", { serviceId: "canonical-chat-key-test" });
    try {
      const nativeA = "1";
      const nativeB = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
      db.setSession(nativeA, "codex", "session-a");
      db.setSession(nativeB, "codex", "session-b");

      const engine = new BridgeEngine({
        kind: "codex",
        surfaceIdentity: "discord:interactive",
        botConfig: { command: "codex", modelPreference: ["default"] },
        allowedUserIds: new Set(["7"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1,
      }, db, fakePlatform());

      await (engine.handleUpdate as any)(resetUpdate(1), nativeB);
      expect(db.getSession(nativeB, "codex")).toBeNull();
      expect(db.getSession(nativeA, "codex")).toBe("session-a");

      await (engine.handleUpdate as any)(resetUpdate(2), nativeA);
      expect(db.getSession(nativeA, "codex")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("persists and reconciles the authoritative key instead of rebuilding it from delivery fields", async () => {
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
      } as any);

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

  it("keeps Telegram topic addressing unchanged", () => {
    expect(resolveUpdateChatKey({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: -1004366290625, type: "supergroup" },
        from: { id: 7, first_name: "User" },
        message_thread_id: 1458,
        text: "hello",
      },
    })).toBe("-1004366290625:1458");
  });
});
