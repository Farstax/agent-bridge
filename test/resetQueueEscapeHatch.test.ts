import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine, type PendingMessage } from "../src/engine.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import * as interactiveBot from "../src/interactiveBot.js";

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

function resetUpdate(messageId: number, chatId = 100) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      chat: { id: chatId, type: "private" },
      from: { id: 42, first_name: "Operator" },
      text: "/reset",
    },
  } as any;
}

function queuedMessage(id: number, chatKey = "100"): PendingMessage {
  return {
    id,
    chatKey,
    prompt: "next task",
    chatId: Number(chatKey),
    threadId: null,
    chatType: "private",
    userId: 42,
    attachments: [],
  };
}

describe("/reset queue escape hatch", () => {
  it("clears only the current lane, resets its session, and invokes transient reset cleanup", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    let resetCleanupCalls = 0;

    db.setSession("100", "codex", "stuck-session");
    db.setSession("200", "codex", "other-session");
    db.enqueueMsg("telegram:interactive", "100", {
      prompt: "stuck work",
      chatId: 100,
      chatType: "private",
      userId: 42,
    });
    db.enqueueMsg("telegram:interactive", "200", {
      prompt: "unrelated work",
      chatId: 200,
      chatType: "private",
      userId: 42,
    });

    const engine = new BridgeEngine(
      {
        kind: "codex",
        surfaceIdentity: "telegram:interactive",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        asyncEnabled: false,
        pollIntervalMs: 1000,
        fullConfig: { allowedUserIds: new Set(["42"]), bots: {} } as any,
        hooks: {
          onReset: async () => { resetCleanupCalls += 1; },
        } as any,
      },
      db,
      client,
    );

    try {
      await engine.handleUpdate(resetUpdate(1));

      expect(resetCleanupCalls).toBe(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(db.pendingMsgCount("telegram:interactive", "200")).toBe(1);
      expect(db.getSession("100", "codex")).toBeNull();
      expect(db.getSession("200", "codex")).toBe("other-session");
      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: "codex session reset. Pending work cleared.",
      }));
    } finally {
      db.close();
    }
  });

  it("invalidates a pending capacity-fallback continuation before the next claimed turn", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const exhaustedChats = new Set<string>();
    const fallbackChain = new WorkerFallbackChain(["codex", "claude"], db);
    const codexClaimed = vi.fn().mockResolvedValue("committed");
    const claudeClaimed = vi.fn().mockResolvedValue("committed");

    const engines = {
      codex: {
        handleUpdate: vi.fn(async () => { exhaustedChats.add("100"); }),
        executeClaimedMessage: codexClaimed,
      },
      claude: {
        handleUpdate: vi.fn(),
        executeClaimedMessage: claudeClaimed,
        // Simulate a busy target lane: fallback stores one-shot tried-state and
        // schedules/retries durable recovery rather than consuming it now.
        recoverPendingQueue: vi.fn().mockResolvedValue(true),
      },
    };
    const deps = {
      engines,
      fallbackChain,
      exhaustedChats,
      db,
      notify: vi.fn(),
    } as any;

    try {
      interactiveBot.setUserCliPreference(db, "100", "codex");
      await interactiveBot.dispatchInteractiveWithFallback({
        update_id: 10,
        message: {
          message_id: 10,
          chat: { id: 100, type: "private" },
          from: { id: 42, first_name: "Operator" },
          text: "stuck task",
        },
      }, "100", deps);

      const resetEngine = new BridgeEngine(
        {
          kind: "codex",
          surfaceIdentity: "telegram:interactive",
          botConfig: { command: "codex", modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "augment",
          asyncEnabled: false,
          pollIntervalMs: 1000,
          fullConfig: { allowedUserIds: new Set(["42"]), bots: {} } as any,
          hooks: {
            onReset: async (chatKey: string) => {
              const clear = (interactiveBot as any).clearInteractiveFallbackState;
              if (typeof clear !== "function") throw new Error("interactive fallback reset cleanup is unavailable");
              clear(fallbackChain, chatKey);
            },
          } as any,
        },
        db,
        client,
      );

      await resetEngine.handleUpdate(resetUpdate(11));
      await interactiveBot.dispatchClaimedInteractiveWithFallback(queuedMessage(99), "100", deps);

      expect(codexClaimed).toHaveBeenCalledTimes(1);
      expect(claudeClaimed).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
