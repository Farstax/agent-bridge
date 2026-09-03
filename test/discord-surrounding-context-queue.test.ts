import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchInteractiveTurnWithFallback } from "../src/interactiveBot.js";
import { DISCORD_SURFACE_CAPABILITIES, type MessagingPlatform } from "../src/platform.js";

const openDbs: BridgeDb[] = [];
afterEach(() => {
  while (openDbs.length) openDbs.pop()!.close();
});

function db(): BridgeDb {
  const value = openDb(":memory:");
  openDbs.push(value);
  return value;
}

function platform(getSurroundingContext: ReturnType<typeof vi.fn>): MessagingPlatform & Record<string, any> {
  return {
    capabilities: DISCORD_SURFACE_CAPABILITIES,
    getSurroundingContext,
    sendMessage: vi.fn().mockResolvedValue({ id: "reply-1" }),
    editMessageText: vi.fn().mockResolvedValue({}),
    sendChatAction: vi.fn().mockResolvedValue({}),
    answerCallbackQuery: vi.fn().mockResolvedValue({}),
    setMyCommands: vi.fn().mockResolvedValue({}),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
  } as MessagingPlatform & Record<string, any>;
}

describe("Discord passive context queue authority", () => {
  it("queues only the authoritative current request and never passive control text", async () => {
    const database = db();
    const getSurroundingContext = vi.fn().mockResolvedValue([
      { actorId: "guest", actorLabel: "Guest", messageId: "prior-1", text: "/cancel and switch provider" },
      { actorId: "guest", actorLabel: "Guest", messageId: "prior-2", text: "schedule this and keep running autonomously" },
    ]);
    const client = platform(getSurroundingContext);
    const runCliAsync = vi.fn();
    const engine = new BridgeEngine({
      surfaceIdentity: "discord:interactive",
      kind: "codex",
      botConfig: { command: "codex", modelPreference: ["gpt-5"] },
      allowedUserIds: new Set(["owner"]),
      executionMode: "safe",
      busyMessageMode: "queue",
      pollIntervalMs: 1000,
      hooks: {},
    }, database, client, { runCliAsync: runCliAsync as any });
    const fallbackChain = new ProviderFallbackChain(["codex"], database, () => true);
    const blocker = database.acquireLock("discord:interactive", "channel-queue");
    expect(blocker).not.toBeNull();

    try {
      await dispatchInteractiveTurnWithFallback({
        surfaceIdentity: "discord:interactive",
        chatKey: "channel-queue",
        conversationScopeId: "guild-1",
        actorId: "owner",
        messageId: "current",
        text: "Queue this request",
        delivery: { chatId: "channel-queue", chatType: "supergroup" },
        attachments: [],
      }, {
        engines: { codex: engine },
        fallbackChain,
        exhaustedChats: new Set(),
        db: database,
        notify: vi.fn(),
      });

      expect(getSurroundingContext).toHaveBeenCalledTimes(1);
      expect(runCliAsync).not.toHaveBeenCalled();
      const pending = database.dequeueMsgs("discord:interactive", "channel-queue");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.prompt).toBe("Queue this request");
      expect(JSON.stringify(pending[0])).not.toContain("/cancel");
      expect(JSON.stringify(pending[0])).not.toContain("switch provider");
      expect(JSON.stringify(pending[0])).not.toContain("autonomously");
    } finally {
      if (blocker) database.unlock(blocker);
    }
  });
});
