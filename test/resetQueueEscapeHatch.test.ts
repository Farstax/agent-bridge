import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine, type PendingMessage } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
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

function makeResetEngine(db: ReturnType<typeof openDb>, client: ReturnType<typeof makeMockClient>) {
  return new BridgeEngine(
    {
      kind: "codex",
      surfaceIdentity: "telegram:interactive",
      botConfig: { command: "codex", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "augment",
      pollIntervalMs: 1000,
      fullConfig: { allowedUserIds: new Set(["42"]), bots: {} } as any,
    },
    db,
    client,
  );
}

describe("/reset queue escape hatch", () => {
  it("clears only the current lane and resets its session", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const engine = makeResetEngine(db, client);
    const fallbackChain = new ProviderFallbackChain(["codex"], db);

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

    try {
      interactiveBot.setUserCliPreference(db, "100", "codex");
      await interactiveBot.dispatchInteractiveWithFallback(resetUpdate(1), "100", {
        engines: { codex: engine },
        fallbackChain,
        exhaustedChats: new Set(),
        db,
        notify: vi.fn(),
      } as any);

      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(db.pendingMsgCount("telegram:interactive", "200")).toBe(1);
      expect(db.getSession("100", "codex")).toBeNull();
      expect(db.getSession("200", "codex")).toBe("other-session");
      expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: "codex session reset. Pending work and conversation history cleared.",
      }));
    } finally {
      db.close();
    }
  });

  it("invalidates multi-provider fallback continuation before a later claimed turn", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const exhaustedChats = new Set<string>();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db);

    const codexInitial = {
      handleUpdate: vi.fn(async () => { exhaustedChats.add("100"); }),
      executeClaimedMessage: vi.fn(),
    };
    const claudeInitial = {
      handleUpdate: vi.fn(async () => { exhaustedChats.add("100"); }),
      executeClaimedMessage: vi.fn(),
      recoverPendingQueue: vi.fn().mockResolvedValue(false),
    };
    const antigravityInitial = {
      handleUpdate: vi.fn(),
      executeClaimedMessage: vi.fn(),
      // Leave the already-tried {codex, claude} marker pending as if this
      // provider lane is still busy and durable recovery will resume later.
      recoverPendingQueue: vi.fn().mockResolvedValue(true),
    };
    const deps: any = {
      engines: {
        codex: codexInitial,
        claude: claudeInitial,
        antigravity: antigravityInitial,
      },
      fallbackChain,
      exhaustedChats,
      db,
      notify: vi.fn(),
    };

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

      expect(codexInitial.handleUpdate).toHaveBeenCalledTimes(1);
      expect(claudeInitial.handleUpdate).toHaveBeenCalledTimes(1);
      expect(antigravityInitial.recoverPendingQueue).toHaveBeenCalledTimes(1);

      // Reset uses the same interactive dispatch boundary as production
      // Telegram/worker surfaces. It must invalidate the stale fallback marker.
      deps.engines.codex = makeResetEngine(db, client);
      await interactiveBot.dispatchInteractiveWithFallback(resetUpdate(11), "100", deps);

      const codexClaimed = vi.fn(async () => {
        exhaustedChats.add("100");
        return "failed" as const;
      });
      const claudeClaimed = vi.fn().mockResolvedValue("committed");
      const antigravityClaimed = vi.fn().mockResolvedValue("committed");
      deps.engines.codex = { handleUpdate: vi.fn(), executeClaimedMessage: codexClaimed };
      deps.engines.claude = { handleUpdate: vi.fn(), executeClaimedMessage: claudeClaimed };
      deps.engines.antigravity = { handleUpdate: vi.fn(), executeClaimedMessage: antigravityClaimed };

      await interactiveBot.dispatchClaimedInteractiveWithFallback(queuedMessage(99), "100", deps);

      expect(codexClaimed).toHaveBeenCalledTimes(1);
      expect(claudeClaimed).toHaveBeenCalledTimes(1);
      expect(antigravityClaimed).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
