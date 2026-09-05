import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      passiveSurroundingContext: false,
      formatting: "telegram-html",
    },
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("conversation-turn post-delivery atomicity", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `conversation-turn-atomicity-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("rolls back the user turn when the assistant turn insert fails, without double-delivering after the answer", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const runCli = vi.fn().mockResolvedValue("the real answer");
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      },
      db,
      client,
      { runCli },
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const realAddConvTurn = db.addConvTurn.bind(db);
    vi.spyOn(db, "addConvTurn")
      .mockImplementationOnce((...args) => realAddConvTurn(...args))
      .mockImplementationOnce(() => {
        throw new Error("simulated assistant conversation_turns write failure");
      });

    await engine.handleMessages([makeMessage("hello")]);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0].text).toBe("the real answer");

    const turns = db.raw.prepare(
      "SELECT role, text FROM conversation_turns WHERE chat_key = ? ORDER BY id ASC",
    ).all("100");
    expect(turns).toEqual([]);

    const warnings = warn.mock.calls.filter(([msg]) => String(msg).includes("conversation-turn write"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain("chatKey=100");
    expect(String(warnings[0][0])).not.toContain("hello");
    expect(String(warnings[0][0])).not.toContain("the real answer");
  });
});
