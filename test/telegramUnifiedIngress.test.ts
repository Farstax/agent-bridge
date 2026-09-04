import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { dispatchUnifiedTelegramUpdate, resolveTelegramControlTargetKind } from "../src/interactiveBot.js";
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

function callback(data: string, userId = 42) {
  return {
    update_id: 1,
    callback_query: {
      id: `cb-${data}`,
      data,
      from: { id: userId },
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
    surfaceIdentity: "telegram:codex",
    kind: "codex",
    botConfig: { command: "codex", modelPreference: ["gpt-5.5", "gpt-5"] },
    allowedUserIds: new Set(["42"]),
    executionMode: "trusted",
    pollIntervalMs: 1,
    fullConfig: { bots: { codex: { command: "codex", modelPreference: ["gpt-5.5", "gpt-5"] } } } as any,
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

  it("routes stale model and effort callbacks to the encoded target provider when available after provider switch", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const agy = antigravityEngine(db, telegram, runCli);
    const codex = codexEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();
    const availableEngines = { antigravity: agy, codex };

    // Active provider is codex (chatKey "100:7"), but user clicks an Antigravity model button
    await dispatchUnifiedTelegramUpdate(
      callback("model:antigravity:gemini-3.8-flash"),
      "100:7",
      "telegram:interactive",
      codex,
      messageDispatch,
      availableEngines,
    );
    expect(db.getSetting("antigravity")).toBe("gemini-3.8-flash");
    expect(db.getSetting("codex")).toBeNull();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-model:antigravity:gemini-3.8-flash" });
    expect(telegram.editMessageText).toHaveBeenCalled();
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();

    // User clicks Antigravity effort button while codex is active
    await dispatchUnifiedTelegramUpdate(
      callback("effort:antigravity:high"),
      "100:7",
      "telegram:interactive",
      codex,
      messageDispatch,
      availableEngines,
    );
    expect(db.getSetting("effort:antigravity")).toBe("high");
    expect(db.getSetting("effort:codex")).toBeNull();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({ callback_query_id: "cb-effort:antigravity:high" });
    expect(telegram.editMessageText).toHaveBeenCalledTimes(2);
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("acknowledges callback as stale and does not mutate when target provider is unavailable", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const codex = codexEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();
    // Only codex is available (e.g. antigravity unavailable or bot locked to codex)
    const availableEngines = { codex };

    await dispatchUnifiedTelegramUpdate(
      callback("model:antigravity:gemini-3.8-flash"),
      "100:7",
      "telegram:interactive",
      codex,
      messageDispatch,
      availableEngines,
    );
    expect(db.getSetting("antigravity")).toBeNull();
    expect(db.getSetting("codex")).toBeNull();
    expect(telegram.answerCallbackQuery).toHaveBeenCalledWith({
      callback_query_id: "cb-model:antigravity:gemini-3.8-flash",
      text: "Control is stale: active provider is codex.",
    });
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("ignores stale callbacks from unauthorized users", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const runCli = vi.fn();
    const agy = antigravityEngine(db, telegram, runCli);
    const codex = codexEngine(db, telegram, runCli);
    const messageDispatch = vi.fn();
    const availableEngines = { antigravity: agy, codex };

    // User 999 is unauthorized
    await dispatchUnifiedTelegramUpdate(
      callback("model:antigravity:gemini-3.8-flash", 999),
      "100:7",
      "telegram:interactive",
      codex,
      messageDispatch,
      availableEngines,
    );
    expect(db.getSetting("antigravity")).toBeNull();
    expect(db.getSetting("codex")).toBeNull();
    expect(telegram.answerCallbackQuery).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(messageDispatch).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("resolves target CLI kinds from control data", () => {
    expect(resolveTelegramControlTargetKind("model:antigravity:gemini-3.8-flash")).toBe("antigravity");
    expect(resolveTelegramControlTargetKind("effort:codex:high")).toBe("codex");
    expect(resolveTelegramControlTargetKind("effort:claude:reset")).toBe("claude");
    expect(resolveTelegramControlTargetKind("model:unknown:foo")).toBeNull();
    expect(resolveTelegramControlTargetKind("queue_mode:queue")).toBeNull();
    expect(resolveTelegramControlTargetKind("cli:codex")).toBeNull();
    expect(resolveTelegramControlTargetKind("")).toBeNull();
    expect(resolveTelegramControlTargetKind(undefined)).toBeNull();
  });
});
