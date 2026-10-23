import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { BTW_PENDING_OCCURRENCE_KEY, openDb, type BridgeDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { acpEngineExec } from "./support/acpEngineExec.js";

describe("global provider execution capacity", () => {
  const dbs: BridgeDb[] = [];
  const paths: string[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const path of paths.splice(0)) {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("atomically shares a cap across separate surface databases using one existing coordinator", () => {
    const coordinatorPath = join(tmpdir(), `execution-capacity-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(coordinatorPath);
    const telegram = openDb(coordinatorPath, { serviceId: "telegram:interactive", runId: "telegram-process" });
    const discord = openDb(coordinatorPath, { serviceId: "discord:interactive", runId: "discord-process" });
    dbs.push(telegram, discord);

    const first = telegram.acquireExecutionCapacity(2, "telegram:chat-1", "telegram-lane-1");
    const second = discord.acquireExecutionCapacity(2, "discord:channel-1", "discord-lane-1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(telegram.executionCapacityCount()).toBe(2);
    expect(discord.acquireExecutionCapacity(2, "discord:channel-2", "discord-lane-2")).toBeNull();

    expect(telegram.releaseExecutionCapacity(first!)).toBe(true);
    expect(discord.acquireExecutionCapacity(2, "discord:channel-2", "discord-lane-2")).not.toBeNull();
  });

  it("recovers a crashed claimant's slot only after its lease expires and fences its late release", () => {
    const coordinatorPath = join(tmpdir(), `execution-capacity-lease-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(coordinatorPath);
    let now = Date.parse("2026-10-18T12:00:00Z");
    const crashed = openDb(coordinatorPath, { serviceId: "telegram:interactive", runId: "old-process", lockLeaseMs: 1_000, clock: () => now });
    const restarted = openDb(coordinatorPath, { serviceId: "telegram:interactive", runId: "new-process", lockLeaseMs: 1_000, clock: () => now });
    dbs.push(crashed, restarted);

    const stale = crashed.acquireExecutionCapacity(1, "chat-1", "lane-1");
    expect(stale).not.toBeNull();
    expect(restarted.acquireExecutionCapacity(1, "chat-2", "lane-2")).toBeNull();
    now += 1_001;
    expect(restarted.acquireExecutionCapacity(1, "chat-2", "lane-2")).not.toBeNull();
    expect(crashed.heartbeatExecutionCapacity(stale!)).toBe(false);
    expect(crashed.releaseExecutionCapacity(stale!)).toBe(false);
    expect(restarted.executionCapacityCount()).toBe(1);
  });

  it("records the queued-capacity notice once per durable receipt", () => {
    const path = join(tmpdir(), `execution-capacity-notice-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "process" });
    dbs.push(db);
    const id = db.enqueueMsg("telegram:interactive", "101", { prompt: "run", chatId: 101, chatType: "private" });
    expect(db.markExecutionCapacityNotified(id)).toBe(true);
    expect(db.markExecutionCapacityNotified(id)).toBe(false);
  });

  it("keeps the unrestricted default: three simultaneous chats all start without a coordinator", async () => {
    const path = join(tmpdir(), `execution-capacity-default-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "process" });
    dbs.push(db);
    const pending: Array<() => void> = [];
    const runCli = vi.fn(() => new Promise<string>((resolve) => pending.push(() => resolve(JSON.stringify({ type: "text", data: "done" }) + "\n" + JSON.stringify({ type: "end", sessionId: "session" }) + "\n"))));
    const client = {
      capabilities: { maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" },
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }), setMyCommands: vi.fn().mockResolvedValue({ ok: true }), answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }), editMessageText: vi.fn().mockResolvedValue({ ok: true }), deleteMessage: vi.fn().mockResolvedValue({ ok: true }), sendPhoto: vi.fn().mockResolvedValue({ ok: true }), sendDocument: vi.fn().mockResolvedValue({ ok: true }), getUpdates: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    } as any;
    const engine = new BridgeEngine({
      kind: "grok", surfaceIdentity: "telegram:interactive", botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1_000, workingDir: process.cwd(),
    }, db, client, acpEngineExec(runCli));
    const runs = [101, 202, 303].map((chatId, index) => engine.handleMessages([{ message_id: index + 1, chat: { id: chatId, type: "private" }, from: { id: 42, first_name: "operator" }, text: "run" }]));
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(3));
    expect(client.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("All agents are currently busy") }));
    pending.splice(0).forEach((resolve) => resolve());
    await Promise.all(runs);
  });

  it("queues a third cross-surface provider invocation once and starts it after a shared slot releases", async () => {
    const coordinatorPath = join(tmpdir(), `execution-capacity-engine-${Date.now()}-${Math.random()}.sqlite`);
    const telegramPath = `${coordinatorPath}.telegram`;
    const discordPath = `${coordinatorPath}.discord`;
    const slackPath = `${coordinatorPath}.slack`;
    paths.push(coordinatorPath, telegramPath, discordPath, slackPath);
    const coordinatorA = openDb(coordinatorPath, { serviceId: "telegram:interactive", runId: "telegram-coordinator" });
    const coordinatorB = openDb(coordinatorPath, { serviceId: "discord:interactive", runId: "discord-coordinator" });
    const coordinatorC = openDb(coordinatorPath, { serviceId: "slack:interactive", runId: "slack-coordinator" });
    const telegramDb = openDb(telegramPath, { serviceId: "telegram:interactive", runId: "telegram-process" });
    const discordDb = openDb(discordPath, { serviceId: "discord:interactive", runId: "discord-process" });
    const slackDb = openDb(slackPath, { serviceId: "slack:interactive", runId: "slack-process" });
    dbs.push(coordinatorA, coordinatorB, coordinatorC, telegramDb, discordDb, slackDb);

    const createCli = () => {
      const pending: Array<{ resolve: () => void }> = [];
      const runCli = vi.fn(() => new Promise<string>((resolve) => pending.push({ resolve: () => resolve(JSON.stringify({ type: "text", data: "done" }) + "\n" + JSON.stringify({ type: "end", sessionId: "session" }) + "\n") })));
      return { runCli, pending };
    };
    const telegramCli = createCli();
    const discordCli = createCli();
    const slackCli = createCli();
    const client = () => ({
      capabilities: { maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" },
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }), setMyCommands: vi.fn().mockResolvedValue({ ok: true }), answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }), editMessageText: vi.fn().mockResolvedValue({ ok: true }), deleteMessage: vi.fn().mockResolvedValue({ ok: true }), sendPhoto: vi.fn().mockResolvedValue({ ok: true }), sendDocument: vi.fn().mockResolvedValue({ ok: true }), getUpdates: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    } as any);
    const makeEngine = (surfaceIdentity: string, db: BridgeDb, coordinator: BridgeDb, clientInstance: any, runCli: ReturnType<typeof vi.fn>) => new BridgeEngine({
      kind: "grok", surfaceIdentity, botConfig: { command: "grok", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1_000, workingDir: process.cwd(), maxConcurrentExecutions: 2, executionCapacityDb: coordinator,
    }, db, clientInstance, acpEngineExec(runCli));
    const telegramClient = client();
    const discordClient = client();
    const slackClient = client();
    const telegram = makeEngine("telegram:interactive", telegramDb, coordinatorA, telegramClient, telegramCli.runCli);
    const discord = makeEngine("discord:interactive", discordDb, coordinatorB, discordClient, discordCli.runCli);
    const slack = makeEngine("slack:interactive", slackDb, coordinatorC, slackClient, slackCli.runCli);
    const message = (id: number, chatId: number) => [{ message_id: id, chat: { id: chatId, type: "private" }, from: { id: 42, first_name: "operator" }, text: "run" }];

    const first = telegram.handleMessages(message(1, 101));
    const second = discord.handleMessages(message(2, 202));
    await vi.waitFor(() => {
      expect(telegramCli.runCli).toHaveBeenCalledTimes(1);
      expect(discordCli.runCli).toHaveBeenCalledTimes(1);
    });
    const slackFailures = vi.spyOn(slackDb, "incrementFailures");
    await expect(slack.handleMessages(message(3, 303))).resolves.toBe("queued");
    expect(slackFailures).not.toHaveBeenCalled();
    expect(slackCli.runCli).not.toHaveBeenCalled();
    expect(slackDb.pendingMsgCount("slack:interactive", "303")).toBe(1);
    expect(slackClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "All agents are currently busy. I've queued your request and will start automatically when capacity is available." }));

    telegramCli.pending.shift()!.resolve();
    await first;
    void slack.recoverPendingQueues();
    await vi.waitFor(() => expect(slackCli.runCli).toHaveBeenCalledTimes(1));
    discordCli.pending.shift()!.resolve();
    slackCli.pending.shift()!.resolve();
    await Promise.all([second, vi.waitFor(() => expect(slackDb.pendingMsgCount("slack:interactive", "303")).toBe(0))]);
  }, 15_000);

  it("never merges a queued /btw receipt with ordinary turns", () => {
    const path = join(tmpdir(), `execution-capacity-btw-merge-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "process" });
    dbs.push(db);
    const msg = (prompt: string, key?: string) => ({ prompt, chatId: 101, chatType: "private", scheduledOccurrenceKey: key });
    db.enqueueMsg("telegram:interactive", "101", msg("first"));
    db.enqueueMsg("telegram:interactive", "101", msg("side", BTW_PENDING_OCCURRENCE_KEY));
    db.enqueueMsg("telegram:interactive", "101", msg("third"));
    const handle = db.acquireLock("telegram:interactive", "101")!;
    const batches: string[][] = [];
    for (;;) {
      const rows = db.claimPendingMsgs(handle);
      if (rows.length === 0) break;
      batches.push(rows.map((row) => row.prompt));
      expect(db.completePendingMsgs(handle, rows.map((row) => row.id))).toBe(true);
    }
    expect(batches).toEqual([["first"], ["side"], ["third"]]);
  });

  it("keeps /btw lock-free beside a running turn when unrestricted", async () => {
    const path = join(tmpdir(), `execution-capacity-btw-free-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "process" });
    dbs.push(db);
    const pending: Array<() => void> = [];
    const runCli = vi.fn(() => new Promise<string>((resolve) => pending.push(() => resolve(JSON.stringify({ type: "text", data: "done" }) + "\n" + JSON.stringify({ type: "end", sessionId: "session" }) + "\n"))));
    const client = {
      capabilities: { maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" },
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }), setMyCommands: vi.fn().mockResolvedValue({ ok: true }), answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }), editMessageText: vi.fn().mockResolvedValue({ ok: true }), deleteMessage: vi.fn().mockResolvedValue({ ok: true }), sendPhoto: vi.fn().mockResolvedValue({ ok: true }), sendDocument: vi.fn().mockResolvedValue({ ok: true }), getUpdates: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    } as any;
    const engine = new BridgeEngine({
      kind: "claude", surfaceIdentity: "telegram:interactive", botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1_000, workingDir: process.cwd(),
    }, db, client, acpEngineExec(runCli));
    const main = engine.handleMessages([{ message_id: 1, chat: { id: 101, type: "private" }, from: { id: 42, first_name: "operator" }, text: "run" }]);
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(1));
    const side = (engine as any)._executeBtw("side question", 101, "101", undefined, 42);
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(2));
    expect(db.pendingMsgCount("telegram:interactive", "101")).toBe(0);
    pending.splice(0).forEach((resolve) => resolve());
    await Promise.all([main, side]);
  });

  it("keeps a /btw side execution as a durable receipt when capacity is full", async () => {
    const coordinatorPath = join(tmpdir(), `execution-capacity-btw-${Date.now()}-${Math.random()}.sqlite`);
    const firstPath = `${coordinatorPath}.first`;
    const sidePath = `${coordinatorPath}.side`;
    paths.push(coordinatorPath, firstPath, sidePath);
    const coordinatorA = openDb(coordinatorPath, { serviceId: "telegram:interactive", runId: "first-coordinator" });
    const coordinatorB = openDb(coordinatorPath, { serviceId: "discord:interactive", runId: "side-coordinator" });
    const firstDb = openDb(firstPath, { serviceId: "telegram:interactive", runId: "first-process" });
    const sideDb = openDb(sidePath, { serviceId: "discord:interactive", runId: "side-process" });
    dbs.push(coordinatorA, coordinatorB, firstDb, sideDb);
    const pending: Array<{ resolve: () => void }> = [];
    const runCli = vi.fn(() => new Promise<string>((resolve) => pending.push({ resolve: () => resolve(JSON.stringify({ type: "text", data: "done" }) + "\n" + JSON.stringify({ type: "end", sessionId: "session" }) + "\n") })));
    const client = () => ({
      capabilities: { maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" },
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }), setMyCommands: vi.fn().mockResolvedValue({ ok: true }), answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }), editMessageText: vi.fn().mockResolvedValue({ ok: true }), deleteMessage: vi.fn().mockResolvedValue({ ok: true }), sendPhoto: vi.fn().mockResolvedValue({ ok: true }), sendDocument: vi.fn().mockResolvedValue({ ok: true }), getUpdates: vi.fn().mockResolvedValue({ ok: true, result: [] }),
    } as any);
    const makeEngine = (surfaceIdentity: string, db: BridgeDb, coordinator: BridgeDb, clientInstance: any) => new BridgeEngine({
      kind: "claude", surfaceIdentity, botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", busyMessageMode: "queue", pollIntervalMs: 1_000, workingDir: process.cwd(), maxConcurrentExecutions: 1, executionCapacityDb: coordinator,
    }, db, clientInstance, acpEngineExec(runCli));
    const first = makeEngine("telegram:interactive", firstDb, coordinatorA, client());
    const sideClient = client();
    const side = makeEngine("discord:interactive", sideDb, coordinatorB, sideClient);
    const firstRun = first.handleMessages([{ message_id: 1, chat: { id: 101, type: "private" }, from: { id: 42, first_name: "operator" }, text: "run" }]);
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(1));

    await (side as any)._executeBtw("side question", 202, "202", undefined, 42);
    expect(sideDb.pendingMsgCount("discord:interactive", "202")).toBe(1);
    expect(sideClient.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "All agents are currently busy. I've queued your request and will start automatically when capacity is available." }));
    expect(runCli).toHaveBeenCalledTimes(1);

    pending.shift()!.resolve();
    await firstRun;
    void side.recoverPendingQueues();
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(2));
    pending.shift()!.resolve();
    await vi.waitFor(() => expect(sideDb.pendingMsgCount("discord:interactive", "202")).toBe(0));
  });
});
