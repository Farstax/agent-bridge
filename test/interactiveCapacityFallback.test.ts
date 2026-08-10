import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  getUserCliPreference,
  setUserCliPreference,
} from "../src/interactiveBot.js";

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

describe("interactive capacity fallback durable admission", () => {
  it("continues one admitted turn across exhausted CLIs without replaying the Telegram update", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new WorkerFallbackChain(["codex", "claude", "antigravity"], db);
    const notifications: string[] = [];

    const codexRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const antigravityRun = vi.fn().mockResolvedValue(JSON.stringify({
      type: "result",
      session_id: "fallback-success-session",
      result: "opened the PR",
    }));

    const makeEngine = (runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        // Use one parser contract for all three keyed engines; this test is about
        // interactive admission/fallback ownership, not provider output parsing.
        kind: "claude",
        botConfig: { command: "claude", modelPreference: ["test-model"] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        asyncEnabled: false,
        pollIntervalMs: 1000,
        hooks: {
          onCapacityExhausted: async (chatKey: string) => {
            exhaustedChats.add(chatKey);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any },
    );

    const engines = {
      codex: makeEngine(codexRun),
      claude: makeEngine(claudeRun),
      antigravity: makeEngine(antigravityRun as any),
    };
    const deps = {
      engines,
      fallbackChain,
      exhaustedChats,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    // Production wires every engine's claimed queue rows back through the
    // shared interactive fallback owner. Keep that boundary in the regression.
    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) =>
        dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, "100", "codex");

      await dispatchInteractiveWithFallback(
        {
          update_id: 9001,
          message: {
            message_id: 77,
            chat: { id: 100, type: "private" },
            from: { id: 42, first_name: "Test" },
            text: "Open a pr for review",
          },
        },
        "100",
        deps,
      );

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(antigravityRun).toHaveBeenCalledTimes(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(getUserCliPreference(db, "100")).toBe("antigravity");
      expect(notifications).toEqual([
        "Switching to claude (codex at capacity)",
        "Switching to antigravity (claude at capacity)",
      ]);

      const finalReplies = client.sendMessage.mock.calls
        .map(([body]: [any]) => body?.text)
        .filter((text: unknown) => text === "opened the PR");
      expect(finalReplies).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
