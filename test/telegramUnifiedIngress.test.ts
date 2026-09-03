import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { dispatchUnifiedTelegramUpdate } from "../src/interactiveBot.js";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 20 } }),
    sendChatAction: vi.fn(),
    sendPhoto: vi.fn(),
    sendDocument: vi.fn(),
    getUpdates: vi.fn(),
    setMyCommands: vi.fn(),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function callback(data: string) {
  return {
    update_id: 1,
    callback_query: {
      id: `cb-${data}`,
      data,
      from: { id: 42 },
      message: { message_id: 12, chat: { id: 100, type: "private" }, message_thread_id: 7 },
    },
  } as any;
}

function antigravityEngine(db: any, telegram: any, runCli: any) {
  return new BridgeEngine({
    surfaceIdentity: "telegram:antigravity",
    kind: "antigravity",
    botConfig: { command: "agy", modelPreference: ["gemini-3.8-flash", "gemini-3.7-flash"] },
    allowedUserIds: new Set(["42"]),
    executionMode: "trusted",
    pollIntervalMs: 1,
    fullConfig: { bots: { antigravity: { command: "agy", modelPreference: ["gemini-3.8-flash", "gemini-3.7-flash"] } } } as any,
  }, db, telegram, { runCli });
}

describe("unified Telegram callback ingress", () => {
  it("routes locked Antigravity model, effort, and queue callbacks to the engine without execution", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const engine = antigravityEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();

    await dispatchUnifiedTelegramUpdate(callback("model:antigravity:gemini-3.8-flash"), "100:7", "telegram:antigravity", engine, messageDispatch);
    expect(db.getSetting("antigravity")).toBe("gemini-3.8-flash");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-model:antigravity:gemini-3.8-flash" });
    expect(telegram.editMessageText).toHaveBeenCalled();
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();

    await dispatchUnifiedTelegramUpdate(callback("effort:antigravity:high"), "100:7", "telegram:antigravity", engine, messageDispatch);
    expect(db.getSetting("effort:antigravity")).toBe("high");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-effort:antigravity:high" });
    expect(telegram.editMessageText).toHaveBeenCalledTimes(2);
    expect(runCli).not.toHaveBeenCalled();

    await dispatchUnifiedTelegramUpdate(callback("queue_mode:queue"), "100:7", "telegram:antigravity", engine, messageDispatch);
    expect(db.getSetting(busyMessageModeSettingKey("telegram:antigravity", "100:7"))).toBe("queue");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-queue_mode:queue", text: "Busy-message mode: queue" });
    expect(telegram.editMessageText).toHaveBeenCalledTimes(3);
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("keeps ordinary messages on the neutral-turn dispatch path", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const engine = antigravityEngine(db, telegram, vi.fn());
    const messageDispatch = vi.fn().mockResolvedValue(undefined);
    const update = {
      update_id: 2,
      message: { message_id: 13, chat: { id: 100, type: "private" }, from: { id: 42 }, text: "hello" },
    } as any;

    await dispatchUnifiedTelegramUpdate(update, "100", "telegram:antigravity", engine, messageDispatch);
    expect(messageDispatch).toHaveBeenCalledOnce();
    expect(messageDispatch.mock.calls[0][0].text).toBe("hello");
    expect(messageDispatch.mock.calls[0][0].surfaceIdentity).toBe("telegram:antigravity");
    expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
    db.close();
  });
});
