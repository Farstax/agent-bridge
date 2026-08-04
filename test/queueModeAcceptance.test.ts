import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { busyMessageModeSettingKey } from "../src/busyMessageMode.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function client() {
  return { sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn(), getUpdates: vi.fn(), setMyCommands: vi.fn(), answerCallbackQuery: vi.fn(), editMessageText: vi.fn() } as any;
}

function engine(db: any, c: any, runCli = vi.fn(), busyMessageMode: "augment" | "interrupt" | "queue" = "augment") {
  return new BridgeEngine({ surfaceIdentity: "telegram:interactive", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode, asyncEnabled: false, pollIntervalMs: 1, fullConfig: { bots: { codex: { command: "codex", modelPreference: [] } } } as any }, db, c, { runCli });
}

function callback(data: string, from = 42, threadId = 7) {
  return { id: `cb-${data}`, data, from: { id: from }, message: { message_id: 12, chat: { id: 100, type: "private" }, message_thread_id: threadId } } as any;
}

async function waitForFile(path: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 2_000 });
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

  it("keeps an active run untouched and queues the next ordinary message after switching to queue", async () => {
    const db = openDb(":memory:"); const c = client();
    let release!: (value: string) => void;
    const runCli = vi.fn()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }))
      .mockResolvedValue("second complete");
    const subject = engine(db, c, runCli);
    const first = subject.handleMessages([{ message_id: 1, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "first" } as any]);
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledOnce());

    await subject.handleCallback(callback("queue_mode:queue"));
    await subject.handleMessages([{ message_id: 2, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "second" } as any]);

    expect(runCli).toHaveBeenCalledOnce();
    // The first accepted turn remains claimed; the new turn is appended rather
    // than being merged, cancelled, or reclassified.
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(2);
    release("first complete");
    await first;
    db.close();
  });

  it("leaves the active run alone until the next interrupt-mode message cancels it", async () => {
    const db = openDb(":memory:"); const c = client(); const ready = join(tmpdir(), `queue-mode-interrupt-${Date.now()}`);
    const successor = vi.fn().mockResolvedValue("second complete");
    const run = vi.fn().mockImplementationOnce((_command, _args, cwd, options) => runCli(process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", ready], cwd, options)).mockImplementationOnce(successor);
    const subject = engine(db, c, run);
    const first = subject.handleMessages([{ message_id: 1, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "first" } as any]);
    await waitForFile(ready);
    await subject.handleCallback(callback("queue_mode:interrupt"));
    expect(run).toHaveBeenCalledOnce();
    await subject.handleMessages([{ message_id: 2, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "second" } as any]);
    await first;
    expect(successor).toHaveBeenCalledOnce();
    db.close(); rmSync(ready, { force: true }); await shutdownCliProcessesAndWait();
  }, 8_000);

  it("leaves the active run alone until the next augment-mode message follows the augment path", async () => {
    const db = openDb(":memory:"); const c = client(); const ready = join(tmpdir(), `queue-mode-augment-${Date.now()}`);
    const successor = vi.fn().mockResolvedValue("combined complete");
    const run = vi.fn().mockImplementationOnce((_command, _args, cwd, options) => runCli(process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", ready], cwd, options)).mockImplementationOnce(successor);
    const subject = engine(db, c, run, "queue");
    await subject.handleCallback(callback("queue_mode:queue"));
    expect(db.getSetting(busyMessageModeSettingKey("telegram:interactive", "100:7"))).toBe("queue");
    const first = subject.handleMessages([{ message_id: 1, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "first" } as any]);
    await waitForFile(ready);
    await subject.handleCallback(callback("queue_mode:augment"));
    expect(run).toHaveBeenCalledOnce();
    await subject.handleMessages([{ message_id: 2, chat: { id: 100, type: "private" }, from: { id: 42 }, message_thread_id: 7, text: "second" } as any]);
    await first;
    expect(successor).toHaveBeenCalledOnce();
    expect(successor.mock.calls[0][1].at(-1)).toContain("second");
    db.close(); rmSync(ready, { force: true }); await shutdownCliProcessesAndWait();
  }, 8_000);
});
