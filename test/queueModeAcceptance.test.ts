import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";

function client() {
  return { sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn(), getUpdates: vi.fn(), setMyCommands: vi.fn(), answerCallbackQuery: vi.fn(), editMessageText: vi.fn() } as any;
}

function engine(db: any, c: any, runCli = vi.fn()) {
  return new BridgeEngine({ surfaceIdentity: "telegram:interactive", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode: "augment", asyncEnabled: false, pollIntervalMs: 1, fullConfig: { bots: { codex: { command: "codex", modelPreference: [] } } } as any }, db, c, { runCli });
}

function callback(data: string, from = 42, threadId = 7) {
  return { id: `cb-${data}`, data, from: { id: from }, message: { message_id: 12, chat: { id: 100, type: "private" }, message_thread_id: threadId } } as any;
}

describe("queue mode callback acceptance", () => {
  it.each(["augment", "interrupt", "queue"])("persists an authorised %s selection and reset at the callback boundary", async (mode) => {
    const db = openDb(":memory:"); const c = client(); const runCli = vi.fn(); const subject = engine(db, c, runCli);
    await subject.handleCallback(callback(`queue_mode:${mode}`));
    const key = busyMessageModeSettingKey("telegram:interactive", "100:7");
    expect(db.getSetting(key)).toBe(mode);
    expect(runCli).not.toHaveBeenCalled();
    await subject.handleCallback(callback("queue_mode:reset"));
    expect(db.getSetting(key)).toBeNull();
    db.close();
  });

  it("rejects unauthorised and malformed callbacks without changing another topic or surface", async () => {
    const db = openDb(":memory:"); const c = client(); const subject = engine(db, c);
    const topicKey = busyMessageModeSettingKey("telegram:interactive", "100:8");
    const discordKey = busyMessageModeSettingKey("discord:interactive", "100:7");
    db.setSetting(topicKey, "queue"); db.setSetting(discordKey, "interrupt");
    await subject.handleCallback(callback("queue_mode:interrupt", 99));
    await subject.handleCallback(callback("queue_mode:not-a-mode"));
    expect(db.getSetting(topicKey)).toBe("queue");
    expect(db.getSetting(discordKey)).toBe("interrupt");
    expect(db.getSetting(busyMessageModeSettingKey("telegram:interactive", "100:7"))).toBeNull();
    db.close();
  });
});
