import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { dispatchUnifiedTelegramUpdate, handleUnavailableCliUpdate, isAuthorizedInteractiveUpdate } from "../src/interactiveBot.js";
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

function callback(data: string, fromId = 42) {
  return {
    update_id: 1,
    callback_query: {
      id: `cb-${data}`,
      data,
      from: { id: fromId },
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

function codexEngine(db: any, telegram: any, runCli: any) {
  return new BridgeEngine({
    surfaceIdentity: "telegram:interactive",
    kind: "codex",
    botConfig: { command: "codex", modelPreference: ["gpt-5.6"] },
    allowedUserIds: new Set(["42"]),
    executionMode: "trusted",
    pollIntervalMs: 1,
    fullConfig: {
      bots: {
        codex: { command: "codex", modelPreference: ["gpt-5.6"] },
        antigravity: { command: "agy", modelPreference: ["gemini-3.8-flash", "gemini-3.7-flash"] },
      },
    } as any,
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

  it("acknowledges stale model and effort callbacks after the active provider changes", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const engine = codexEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();
    db.setSetting("antigravity", "gemini-3.7-flash");
    db.setSetting("effort:antigravity", "medium");

    await dispatchUnifiedTelegramUpdate(callback("model:antigravity:gemini-3.8-flash"), "100:7", "telegram:interactive", engine, messageDispatch);
    expect(db.getSetting("antigravity")).toBe("gemini-3.7-flash");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-model:antigravity:gemini-3.8-flash",
      text: "Stale model menu: active provider is codex. Reopen /models.",
    });
    expect(telegram.editMessageText).not.toHaveBeenCalled();

    await dispatchUnifiedTelegramUpdate(callback("effort:antigravity:high"), "100:7", "telegram:interactive", engine, messageDispatch);
    expect(db.getSetting("effort:antigravity")).toBe("medium");
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-effort:antigravity:high",
      text: "Stale effort menu: active provider is codex. Reopen /effort.",
    });
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("keeps unauthorized stale callbacks behind the unified ingress authorization gate", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const engine = codexEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();
    const update = callback("model:antigravity:gemini-3.8-flash", 999);
    const allowedUserIds = new Set(["42"]);

    if (isAuthorizedInteractiveUpdate(update, allowedUserIds)) {
      await dispatchUnifiedTelegramUpdate(update, "100:7", "telegram:interactive", engine, messageDispatch);
    }

    expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("completes callback and ordinary-message handling when no CLI is available", async () => {
    const telegram = client();
    const sendUnavailableMessage = vi.fn().mockResolvedValue(undefined);

    expect(await handleUnavailableCliUpdate(callback("model:antigravity:gemini-3.8-flash"), telegram, sendUnavailableMessage)).toBe(true);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-model:antigravity:gemini-3.8-flash",
      text: "No CLI is currently available. Authenticate or install a CLI, then run /cli again.",
    });
    expect(sendUnavailableMessage).not.toHaveBeenCalled();

    const noChatCallback = callback("effort:antigravity:high");
    delete noChatCallback.callback_query.message;
    expect(await handleUnavailableCliUpdate(noChatCallback, telegram, sendUnavailableMessage)).toBe(true);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-effort:antigravity:high",
      text: "No CLI is currently available. Authenticate or install a CLI, then run /cli again.",
    });

    const ordinaryUpdate = {
      update_id: 3,
      message: { message_id: 14, chat: { id: 100, type: "private" }, from: { id: 42 }, text: "hello" },
    } as any;
    expect(await handleUnavailableCliUpdate(ordinaryUpdate, telegram, sendUnavailableMessage)).toBe(true);
    expect(sendUnavailableMessage).toHaveBeenCalledWith(100, undefined);
    expect(telegram.answerCallbackQuery).toHaveBeenCalledTimes(2);
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
