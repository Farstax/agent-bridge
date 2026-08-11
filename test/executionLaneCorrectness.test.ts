import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";
import { dispatchClaimedInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";
import * as fileOutput from "../src/fileOutput.js";

function message(text: string, threadId: number) {
  return { message_id: Math.random(), chat: { id: 100, type: "private" }, from: { id: 42, first_name: "T" }, message_thread_id: threadId, text } as any;
}

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }), sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn(), sendDocument: vi.fn(), getUpdates: vi.fn(), setMyCommands: vi.fn(), answerCallbackQuery: vi.fn(), editMessageText: vi.fn(),
  } as any;
}

function options(kind: "codex" | "claude", hooks: any = {}) {
  return { surfaceIdentity: "telegram:interactive", kind, botConfig: { command: kind, modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe" as const, busyMessageMode: "interrupt" as const, asyncEnabled: false, pollIntervalMs: 1000, hooks };
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("execution lane correctness", () => {
  it("fences delayed work from a previous acquisition by the same process run", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "same-process" });
    const acquisitionA = db.acquireLock("telegram:interactive", "100:7");
    expect(acquisitionA).not.toBeNull();
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "claimed by A", chatId: 100, threadId: 7, chatType: "private" });
    const claimedByA = db.claimNextPendingMsg(acquisitionA!);
    expect(claimedByA?.prompt).toBe("claimed by A");

    expect(db.unlock(acquisitionA!)).toBe(true);
    const acquisitionB = db.acquireLock("telegram:interactive", "100:7");
    expect(acquisitionB).not.toBeNull();
    expect(acquisitionB!.acquisitionId).not.toBe(acquisitionA!.acquisitionId);

    expect(() => db.runWithLockFence(acquisitionA!, () => db.setSetting("stale-commit", "bad")))
      .toThrow("execution lock ownership lost");
    expect(db.completePendingMsg(acquisitionA!, claimedByA!.id)).toBe(false);
    expect(db.heartbeatLock(acquisitionA!)).toBe(false);
    expect(db.unlock(acquisitionA!)).toBe(false);
    expect(db.ownsLock(acquisitionB!)).toBe(true);

    db.runWithLockFence(acquisitionB!, () => db.setSetting("current-commit", "good"));
    expect(db.getSetting("stale-commit")).toBeNull();
    expect(db.getSetting("current-commit")).toBe("good");
    expect(db.unlock(acquisitionB!)).toBe(true);
    db.close();
  });

  it("claims FIFO queue rows only for the run that owns the lane and retains them until completion", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "run-a" });
    const handle = db.acquireLock("telegram:interactive", "100:7")!;
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "newest", chatId: 100, threadId: 7, chatType: "private" });
    const first = db.claimNextPendingMsg(handle);
    expect(first?.prompt).toBe("oldest");
    expect(db.claimNextPendingMsg(handle)).toBeNull();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(2);
    expect(db.unlockIfQueueEmpty(handle)).toBe(false);
    expect(db.completePendingMsg(handle, first!.id)).toBe(true);
    expect(db.claimNextPendingMsg(handle)?.prompt).toBe("newest");
    db.close();
  });

  it("recovers a claimed row after stale takeover instead of losing it", () => {
    const path = join(tmpdir(), `pending-claim-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const clock = () => now;
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "run-a", lockLeaseMs: 500, clock });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "durable", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA);
    expect(claimed?.prompt).toBe("durable");
    const earlyRunB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    expect(earlyRunB.completePendingMsg(handleA, claimed!.id)).toBe(false);
    earlyRunB.close(); runA.close(); now += 501;
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock });
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    expect(runB.claimNextPendingMsg(handleB)?.prompt).toBe("durable");
    runB.close(); rmSync(path, { force: true });
  });

  it("routes a claimed interactive message through the current provider while retaining lane ownership", async () => {
    const path = join(tmpdir(), `route-claim-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path, { serviceId: "telegram:interactive", runId: "live-run" });
    const c = client();
    const codexRun = vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
      process.execPath,
      ["-e", "setTimeout(()=>console.log('codex done'),200)"],
      cwd,
      cliOptions,
    ));
    const claudeRun = vi.fn().mockResolvedValue("claude done");
    const fallbackChain = new WorkerFallbackChain(["codex", "claude"], db);
    const exhaustedChats = new Set<string>();
    const engines = {} as Record<string, BridgeEngine>;
    // This test is about durable FIFO routing across providers, not busy-mode
    // admission — pin busyMessageMode explicitly so a default flip elsewhere
    // can't change this test's meaning.
    const codex = new BridgeEngine({
      ...options("codex", {
        onQueuedMessage: (queued: any) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, {
          engines, fallbackChain, exhaustedChats, db, notify: vi.fn(),
        }),
      }),
      busyMessageMode: "queue",
    }, db, c, { runCli: codexRun });
    const claude = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, { runCli: claudeRun });
    engines.codex = codex; engines.claude = claude;
    const active = codex.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    setUserCliPreference(db, "100:7", "claude");
    await claude.handleMessages([message("queued for current Claude", 7)]);
    await active;
    expect(codexRun).toHaveBeenCalledOnce();
    expect(claudeRun).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("returns busy for /compact in an active topic lane while another topic remains independent", async () => {
    const path = join(tmpdir(), `compact-lane-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, { runCli: vi.fn().mockResolvedValue('{"summary_md":"topic eight summary","memory_candidates":[]}') });
    db.addConvTurn("100", "user", "quarantined flat history");
    db.addConvTurn("100:7", "user", "topic seven"); db.addConvTurn("100:8", "user", "topic eight");
    db.acquireLock("telegram:interactive", "100:7");
    await engine.handleMessages([message("/compact", 7)]);
    expect(c.sendMessage.mock.calls.some((call: any[]) => /busy|active/i.test(call[0].text))).toBe(true);
    await engine.handleMessages([message("/compact", 8)]);
    expect(db.getConvTurnsForCompaction("100:8")).toHaveLength(0);
    expect(db.getConvTurnsForCompaction("100:7")).toHaveLength(1);
    expect(db.getConvTurnsForCompaction("100").map((turn) => turn.text)).toEqual(["quarantined flat history"]);
    db.close(); rmSync(path, { force: true });
  });

  it("runs /btw as a fresh tool-free side invocation without the main lane or session", async () => {
    const path = join(tmpdir(), `btw-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const runCli = vi.fn().mockResolvedValue('{"result":"side answer","session_id":"side-session"}');
    const engine = new BridgeEngine(options("claude"), db, c, { runCli });

    await engine.handleMessages([message("/btw inspect the repository without changing it", 7)]);

    expect(runCli).toHaveBeenCalledOnce();
    const [, args, , cliOptions] = runCli.mock.calls[0];
    expect(args).toContain("--print");
    expect(args).toContain("--tools");
    expect(args).toContain("");
    expect(args).not.toContain("--resume");
    expect(cliOptions.bypassWorkspaceLock).toBe(true);
    expect(String(cliOptions.chatId)).toMatch(/btw/);
    expect(db.getSession("100:7", "claude")).toBeNull();
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "side answer")).toBe(true);

    db.close(); rmSync(path, { force: true });
  });

  it("keeps the lane owned until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `stop-grace-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `stop-grace-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long run", 7)]);
    await waitForFile(childReady);
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });
    await new Promise((r) => setTimeout(r, 100));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();
    await stopping; await active;
    await waitForCondition(() => db.acquireLock("telegram:interactive", "100:7") !== null, 8_000);
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("keeps the lane owned during /reset until a TERM-resistant child exits after SIGKILL", async () => {
    const path = join(tmpdir(), `reset-grace-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `reset-grace-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const engine = new BridgeEngine(options("claude"), db, c, {
      runCli: (_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
        cwd,
        cliOptions,
      ),
    });
    const active = engine.handleMessages([message("long reset run", 7)]);
    await waitForFile(childReady);
    const resetting = engine.handleMessages([message("/reset", 7)]);
    await new Promise((r) => setTimeout(r, 100));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();
    await resetting; await active;
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("interrupt mode aborts the active turn and admits the next message immediately instead of waiting in FIFO (Issue #177)", async () => {
    const path = join(tmpdir(), `interrupt-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `interrupt-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const secondTurnRun = vi.fn().mockResolvedValue('{"result":"second turn done","session_id":"s2"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(secondTurnRun),
    });
    const startedAt = Date.now();
    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(childReady);
    const second = engine.handleMessages([message("interrupt with this", 7)]);
    await Promise.all([first, second]);
    const elapsedMs = Date.now() - startedAt;

    // Proves the second turn did not wait for the first turn's natural 10s completion.
    // The child honours SIGTERM (no ignore handler), so abort should land in well under 1s.
    expect(elapsedMs).toBeLessThan(3_000);
    expect(secondTurnRun).toHaveBeenCalledOnce();
    // The killed first turn must never commit a session — only the second turn's session lands.
    expect(db.getSession("100:7", "claude")).toBe("s2");
    // Exactly one assistant reply was delivered (the second turn's) — the interrupted
    // first turn must not send a committed final response.
    const finalReplies = c.sendMessage.mock.calls.filter((call: any[]) => call[0].text === "second turn done");
    expect(finalReplies).toHaveLength(1);
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("coalesces two simultaneous interrupt requests into one cancellation and one drainer", async () => {
    const path = join(tmpdir(), `interrupt-coalesce-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `interrupt-coalesce-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const secondRun = vi.fn().mockResolvedValue('{"result":"second done","session_id":"s2"}');
    const thirdRun = vi.fn().mockResolvedValue('{"result":"third done","session_id":"s3"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(secondRun)
        .mockImplementationOnce(thirdRun),
    });

    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(childReady);
    const second = engine.handleMessages([message("second interrupt", 7)]);
    await waitForCondition(() => c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "⏹️ Interrupting current work..."));
    const third = engine.handleMessages([message("third interrupt", 7)]);

    await Promise.all([first, second, third]);

    expect(secondRun).toHaveBeenCalledOnce();
    expect(thirdRun).toHaveBeenCalledOnce();
    expect(db.getSession("100:7", "claude")).toBe("s3");
    expect(c.sendMessage.mock.calls.filter((call: any[]) => ["second done", "third done"].includes(call[0]?.text))).toHaveLength(2);
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 8_000);

  it("upgrades an in-flight interrupt to /stop and discards the queued successor", async () => {
    const path = join(tmpdir(), `interrupt-stop-upgrade-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `interrupt-stop-upgrade-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const successorRun = vi.fn().mockResolvedValue('{"result":"must be discarded","session_id":"bad"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
        cwd,
        cliOptions,
      )).mockImplementationOnce(successorRun),
    });

    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(childReady);
    const interrupting = engine.handleMessages([message("queued successor", 7)]);
    await waitForCondition(() => c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "⏹️ Interrupting current work..."));
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });

    await Promise.all([first, interrupting, stopping]);

    expect(successorRun).not.toHaveBeenCalled();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect(db.getSession("100:7", "claude")).toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 12_000);

  it("allows a new interrupt to terminate a successor while it is running", async () => {
    const path = join(tmpdir(), `successor-interrupt-${Date.now()}-${Math.random()}.sqlite`);
    const firstReady = join(tmpdir(), `successor-interrupt-first-${Date.now()}-${Math.random()}`);
    const successorReady = join(tmpdir(), `successor-interrupt-successor-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const newestRun = vi.fn().mockResolvedValue('{"result":"newest done","session_id":"newest"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", firstReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", successorReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(newestRun),
    });

    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(firstReady);
    const successor = engine.handleMessages([message("successor", 7)]);
    await waitForFile(successorReady, 8_000);
    const newest = engine.handleMessages([message("newest", 7)]);

    await Promise.all([first, successor, newest]);

    expect(newestRun).toHaveBeenCalledOnce();
    expect(db.getSession("100:7", "claude")).toBe("newest");
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === "newest done")).toHaveLength(1);
    db.close(); rmSync(path, { force: true }); rmSync(firstReady, { force: true }); rmSync(successorReady, { force: true });
  }, 18_000);

  it("cancels a running successor and pending work when /stop arrives", async () => {
    const path = join(tmpdir(), `successor-stop-${Date.now()}-${Math.random()}.sqlite`);
    const firstReady = join(tmpdir(), `successor-stop-first-${Date.now()}-${Math.random()}`);
    const successorReady = join(tmpdir(), `successor-stop-successor-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const successorRun = vi.fn();
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", firstReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", successorReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(successorRun),
    });

    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(firstReady);
    const successor = engine.handleMessages([message("successor", 7)]);
    await waitForFile(successorReady, 8_000);
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "pending", chatId: 100, threadId: 7, chatType: "private" });
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });

    await Promise.all([first, successor, stopping]);

    expect(successorRun).not.toHaveBeenCalled();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect(db.getSession("100:7", "claude")).toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(firstReady, { force: true }); rmSync(successorReady, { force: true });
  }, 18_000);

  it("does not clear /stop cancellation while process-tree finalization is waiting", async () => {
    const path = join(tmpdir(), `stop-race-${Date.now()}-${Math.random()}.sqlite`);
    const childReady = join(tmpdir(), `stop-race-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const afterStop = vi.fn().mockResolvedValue('{"result":"after stop","session_id":"after-stop"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "interrupt" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", childReady],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(afterStop),
    });

    const first = engine.handleMessages([message("long first turn", 7)]);
    await waitForFile(childReady);
    const stopping = engine.handleUpdate({ update_id: 2, message: message("/stop", 7) });
    await waitForCondition(() => db.acquireLock("telegram:interactive", "100:7") === null);
    const next = engine.handleMessages([message("after stop", 7)]);

    await Promise.all([first, stopping, next]);

    expect(afterStop).toHaveBeenCalledOnce();
    expect(db.getSession("100:7", "claude")).toBe("after-stop");
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === "after stop")).toHaveLength(1);
    expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    db.close(); rmSync(path, { force: true }); rmSync(childReady, { force: true });
  }, 12_000);

  it("fails closed for Antigravity /btw without changing provider settings", async () => {
    const path = join(tmpdir(), `btw-agy-${Date.now()}-${Math.random()}.sqlite`);
    const home = mkdtempSync(join(tmpdir(), "btw-agy-home-"));
    const settingsDir = join(home, ".gemini", "antigravity-cli");
    const settingsPath = join(settingsDir, "settings.json");
    const original = Buffer.from('{"model":"Gemini 3.5 Flash (High)","theme":"dark"}\n');
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, original);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const db = openDb(path);
    const c = client();
    const runCli = vi.fn().mockResolvedValue('{"result":"must not run"}');
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "antigravity", botConfig: { command: "agy", modelPreference: ["gemini-3.5-flash-high"] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, c, { runCli });

    try {
      await engine.handleMessages([message("/btw inspect without changing anything", 7)]);
      expect(runCli).not.toHaveBeenCalled();
      expect(readFileSync(settingsPath)).toEqual(original);
      expect(c.sendMessage.mock.calls.some((call: any[]) => /unavailable/i.test(call[0]?.text))).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      db.close(); rmSync(path, { force: true }); rmSync(home, { recursive: true, force: true });
    }
  });

  it("a configured hard timeout follows the /stop cancellation path — discards queued work, preserves last committed session (Issue #177)", async () => {
    const path = join(tmpdir(), `timeout-cancel-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const savedTimeout = process.env.CLAUDE_CLI_TIMEOUT_MS;
    const savedIdle = process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS;
    process.env.CLAUDE_CLI_TIMEOUT_MS = "300";
    process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = "0";
    const secondRun = vi.fn().mockResolvedValue("should never run");
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
          process.execPath,
          ["-e", "setTimeout(()=>{},10000)"],
          cwd,
          cliOptions,
        ))
        .mockImplementationOnce(secondRun),
    });
    try {
      const first = engine.handleMessages([message("times out", 7)]);
      await new Promise((r) => setTimeout(r, 50));
      const second = engine.handleMessages([message("queued behind the timeout", 7)]);
      await Promise.all([first, second]);

      // The queued message must be discarded, not executed — same as /stop.
      expect(secondRun).not.toHaveBeenCalled();
      expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
      // No session was committed by the timed-out turn.
      expect(db.getSession("100:7", "claude")).toBeNull();
      // The lane is released, not stuck.
      expect(db.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    } finally {
      if (savedTimeout === undefined) delete process.env.CLAUDE_CLI_TIMEOUT_MS; else process.env.CLAUDE_CLI_TIMEOUT_MS = savedTimeout;
      if (savedIdle === undefined) delete process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS; else process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = savedIdle;
      db.close(); rmSync(path, { force: true });
    }
  }, 8_000);

  it("queue mode (explicit) still waits for the active turn's natural completion before running the next message", async () => {
    const path = join(tmpdir(), `queue-mode-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const codexRun = vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
      process.execPath,
      ["-e", "setTimeout(()=>console.log('first done'),150)"],
      cwd,
      cliOptions,
    ));
    const secondRun = vi.fn().mockResolvedValue("second done");
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "queue" }, db, c, {
      runCli: vi.fn().mockImplementationOnce(codexRun).mockImplementationOnce(secondRun),
    });
    const first = engine.handleMessages([message("first", 7)]);
    await new Promise((r) => setTimeout(r, 20));
    const second = engine.handleMessages([message("second", 7)]);
    await Promise.all([first, second]);
    expect(codexRun).toHaveBeenCalledOnce();
    expect(secondRun).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("claims an ordered augmented batch with every attachment under one lane fence", () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "augment-batch" });
    const handle = db.acquireLock("telegram:interactive", "100:7")!;
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "original request", chatId: 100, threadId: 7, chatType: "private", attachments: ["/tmp/original"] });
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "first addition", chatId: 100, threadId: 7, chatType: "private", attachments: ["/tmp/first"] });
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "second addition", chatId: 100, threadId: 7, chatType: "private", attachments: ["/tmp/second"] });

    const claimed = db.claimPendingMsgs(handle);
    expect(claimed.map((row) => row.prompt)).toEqual(["original request", "first addition", "second addition"]);
    expect(claimed.flatMap((row) => row.attachments)).toEqual(["/tmp/original", "/tmp/first", "/tmp/second"]);
    expect(db.completePendingMsgs(handle, claimed.map((row) => row.id))).toBe(true);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close();
  });

  it("augments the active task by default and coalesces additions in arrival order", async () => {
    const path = join(tmpdir(), `augment-mode-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    const c = client();
    const prompts: string[] = [];
    const mockRunCli = vi.fn().mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
      process.execPath,
      ["-e", "setTimeout(()=>{},10000)"],
      cwd,
      cliOptions,
    )).mockResolvedValueOnce('{"result":"augmented result","session_id":"augmented-session"}');
    const engine = new BridgeEngine({
      ...options("claude", { onBeforeExecute: async (prompt: string) => { prompts.push(prompt); return prompt; } }), busyMessageMode: "augment",
    }, db, c, { runCli: mockRunCli });
    const first = engine.handleMessages([message("original request", 7)]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.dequeueMsgs("telegram:interactive", "100:7").map((row) => row.prompt)).toContain("original request");
    const second = engine.handleMessages([message("first addition", 7)]);
    const third = engine.handleMessages([message("second addition", 7)]);
    await Promise.all([first, second, third]);
    expect(prompts[0]).toBe("original request");
    expect(prompts.at(-1)).toBe("original request\n\nfirst addition\n\nsecond addition");
    expect(mockRunCli).toHaveBeenCalledTimes(2);
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === "augmented result")).toHaveLength(1);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  }, 8_000);

  it("recovers the complete augmented task after a service restart", async () => {
    const path = join(tmpdir(), `augment-restart-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-30T16:30:00.000Z");
    writeFileSync("/tmp/original-after-restart", "original attachment");
    writeFileSync("/tmp/addition-after-restart", "addition attachment");
    const oldDb = openDb(path, { serviceId: "telegram:interactive", runId: "before-restart", lockLeaseMs: 100, clock: () => now });
    const oldHandle = oldDb.acquireLock("telegram:interactive", "100:7")!;
    oldDb.enqueueMsg("telegram:interactive", "100:7", { prompt: "original after restart", chatId: 100, threadId: 7, chatType: "private", attachments: ["/tmp/original-after-restart"] });
    oldDb.enqueueMsg("telegram:interactive", "100:7", { prompt: "addition after restart", chatId: 100, threadId: 7, chatType: "private", attachments: ["/tmp/addition-after-restart"] });
    expect(oldDb.claimNextPendingMsg(oldHandle)?.prompt).toBe("original after restart");
    oldDb.close();
    now += 101;

    const db = openDb(path, { serviceId: "telegram:interactive", runId: "after-restart", lockLeaseMs: 100, clock: () => now });
    const prompts: string[] = [];
    const engine = new BridgeEngine({
      ...options("claude"), busyMessageMode: "augment",
      hooks: { onAfterExecute: async (prompt: string) => { prompts.push(prompt); } },
    }, db, client(), { runCli: vi.fn().mockResolvedValue('{"result":"recovered","session_id":"recovered-session"}') });
    await engine.recoverPendingQueues();
    expect(prompts).toEqual(["original after restart\n\naddition after restart"]);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true }); rmSync("/tmp/original-after-restart", { force: true }); rmSync("/tmp/addition-after-restart", { force: true });
  });

  it("cancels an augmented successor and reruns the complete batch when a later addition arrives", async () => {
    const path = join(tmpdir(), `augment-successor-${Date.now()}-${Math.random()}.sqlite`);
    const firstReady = join(tmpdir(), `augment-successor-first-${Date.now()}-${Math.random()}`);
    const successorReady = join(tmpdir(), `augment-successor-next-${Date.now()}-${Math.random()}`);
    const db = openDb(path);
    const c = client();
    const finalRun = vi.fn().mockResolvedValue('{"result":"augmented final","session_id":"augmented-final"}');
    const engine = new BridgeEngine({ ...options("claude"), busyMessageMode: "augment" }, db, c, {
      runCli: vi.fn()
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", firstReady], cwd, cliOptions))
        .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", successorReady], cwd, cliOptions))
        .mockImplementationOnce(finalRun),
    });

    const first = engine.handleMessages([message("original successor", 7)]);
    await waitForFile(firstReady);
    const successor = engine.handleMessages([message("first successor addition", 7)]);
    await waitForFile(successorReady);
    const newest = engine.handleMessages([message("latest successor addition", 7)]);
    await Promise.all([first, successor, newest]);

    expect(finalRun).toHaveBeenCalledOnce();
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === "augmented final")).toHaveLength(1);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true }); rmSync(firstReady, { force: true }); rmSync(successorReady, { force: true });
  }, 12_000);

  it("keeps /reset fenced through delayed finalisation before allowing a new acquisition", async () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "same-process" });
    const c = client();
    let resumeFinalisation!: () => void;
    const delayedFinalisation = new Promise<void>((resolve) => { resumeFinalisation = resolve; });
    let hookCalls = 0;
    const runCli = vi.fn().mockResolvedValueOnce("old result").mockResolvedValueOnce("new result");
    const engine = new BridgeEngine(options("claude", {
      onAfterExecute: async () => {
        hookCalls += 1;
        if (hookCalls === 1) await delayedFinalisation;
      },
    }), db, c, { runCli });

    const oldRun = engine.handleMessages([message("old request", 7)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reset = engine.handleMessages([message("/reset", 7)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(db.acquireLock("telegram:interactive", "100:7")).toBeNull();

    resumeFinalisation();
    await oldRun;
    await reset;
    await engine.handleMessages([message("new request", 7)]);

    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "old result")).toBe(false);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "new result")).toBe(true);
    expect(db.getSession("100:7", "claude")).not.toBe("old result");
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close();
  });

  it.each([
    { mode: "synchronous", asyncEnabled: false },
    { mode: "asynchronous", asyncEnabled: true },
  ])("does not persist a cancelled result during $mode finalisation", async ({ mode, asyncEnabled }) => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: `cancelled-finalisation-${mode}` });
    const c = client();
    const chatKey = "100:7";
    const oldSession = "previous-session";
    const nextSession = "next-session";
    const oldTurns = [
      ["user", "previous request"],
      ["assistant", "previous answer"],
    ] as const;
    for (const [role, text] of oldTurns) db.addConvTurn(chatKey, role, text, "claude");
    db.setSession(chatKey, "claude", oldSession);
    db.addMemory({ id: "previous-memory", type: "decision", scope: "project", text: "previous durable memory" });
    const turnsBefore = db.getConvTurnsForCompaction(chatKey).map(({ role, text, cli }) => ({ role, text, cli }));
    const memoryCountBefore = db.getMemoryCount();
    let releaseFinalisation!: () => void;
    let finalisationEntered!: () => void;
    const finalisation = new Promise<void>((resolve) => { releaseFinalisation = resolve; });
    const entered = new Promise<void>((resolve) => { finalisationEntered = resolve; });
    const cancelledResult = JSON.stringify({
      result: `cancelled ${mode} result\n<!-- agent-bridge-memory [{"type":"decision","scope":"project","text":"must not persist ${mode}"}] -->`,
      session_id: nextSession,
    });
    const nextRun = vi.fn().mockResolvedValue(JSON.stringify({ result: "next result", session_id: "after-cancel" }));
    const hooks = {
      onAfterExecute: async (prompt: string) => {
        if (prompt === `cancelled ${mode}`) {
          finalisationEntered();
          await finalisation;
        }
      },
    };
    const engine = new BridgeEngine({ ...options("claude", hooks), busyMessageMode: "interrupt", asyncEnabled }, db, c, {
      runCli: vi.fn().mockResolvedValueOnce(cancelledResult).mockImplementationOnce(nextRun),
      runCliAsync: vi.fn().mockResolvedValueOnce({ text: cancelledResult }).mockImplementationOnce(async () => ({ text: await nextRun() })),
    });

    const cancelled = engine.handleMessages([message(`cancelled ${mode}`, 7)]);
    await entered;
    const stopping = engine.handleUpdate({ update_id: 700, message: message("/stop", 7) });
    await waitForCondition(() => db.acquireLock("telegram:interactive", chatKey) === null);
    releaseFinalisation();
    await Promise.all([cancelled, stopping]);

    expect(db.getSession(chatKey, "claude")).toBe(oldSession);
    expect(db.getConvTurnsForCompaction(chatKey).map(({ role, text, cli }) => ({ role, text, cli }))).toEqual(turnsBefore);
    expect(db.getMemoryCount()).toBe(memoryCountBefore);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text?.includes(`cancelled ${mode} result`))).toBe(false);

    await engine.handleMessages([message("resume after cancellation", 7)]);
    expect(nextRun).toHaveBeenCalled();
    expect(db.getSession(chatKey, "claude")).toBe("after-cancel");
    db.close();
  });

  it.each([
    { mode: "synchronous", asyncEnabled: false },
    { mode: "asynchronous", asyncEnabled: true },
  ])("fences /stop before a claimed $mode final-delivery phase settles", async ({ mode, asyncEnabled }) => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: `delivery-phase-${mode}` });
    let releaseDelivery!: () => void;
    let deliveryEntered!: () => void;
    const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const entered = new Promise<void>((resolve) => { deliveryEntered = resolve; });
    const c = client();
    c.sendMessage.mockImplementation(async (body: any) => {
      if (String(body.text).includes(`delivery winner ${mode}`)) {
        deliveryEntered();
        await delivery;
      }
      return { ok: true, result: { message_id: 1 } };
    });
    db.setSession("100:7", "claude", "previous-session");
    const result = JSON.stringify({ result: `delivery winner ${mode}`, session_id: "delivered-session" });
    const engine = new BridgeEngine({ ...options("claude"), asyncEnabled }, db, c, {
      runCli: vi.fn().mockResolvedValue(result),
      runCliAsync: vi.fn().mockResolvedValue({ text: result }),
    });

    const execution = engine.handleMessages([message(`delivery ${mode}`, 7)]);
    await entered;
    const stopping = engine.handleUpdate({ update_id: 701, message: message("/stop", 7) });
    const executionLane = JSON.stringify(["telegram:interactive", "100:7"]);
    expect((engine as any).laneCoordinator.isAborted(executionLane)).toBe(true);
    await stopping;
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "🛑 Execution aborted by user.")).toBe(true);

    releaseDelivery();
    await execution;
    await waitForCondition(() => !(engine as any).laneCoordinator.hasCancellation(executionLane));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(db.getSession("100:7", "claude")).toBe("previous-session");
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === `delivery winner ${mode}`)).toBe(true);
    db.close();
  });

  it.each(["augment", "interrupt"] as const)("installs the stop fence when upgrading a $mode cancellation behind final delivery", async (mode) => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: `upgrade-${mode}` });
    const engine = new BridgeEngine(options("claude"), db, client());
    const chatKey = "100:7";
    const executionLane = JSON.stringify(["telegram:interactive", chatKey]);
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    (engine as any).laneCoordinator.setFinalDelivery(executionLane, { promise: delivery, release });
    db.enqueueMsg("telegram:interactive", chatKey, { prompt: "discard me", chatId: 100, threadId: 7, chatType: "private" });

    const firstCancellation = (engine as any)._cancelLane(chatKey, mode);
    const stopCancellation = (engine as any)._cancelLane(chatKey, "stop");

    expect((engine as any).laneCoordinator.isAborted(executionLane)).toBe(true);
    expect(db.pendingMsgCount("telegram:interactive", chatKey)).toBe(0);

    release();
    await Promise.all([firstCancellation, stopCancellation]);
    db.close();
  });

  it.each([
    { mode: "synchronous", asyncEnabled: false },
    { mode: "asynchronous", asyncEnabled: true },
  ])("starts a separate turn for a message admitted after $mode final delivery begins", async ({ mode, asyncEnabled }) => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: `augment-final-fence-${mode}` });
    const c = client();
    let releaseDelivery!: () => void;
    let deliveryEntered!: () => void;
    const delivery = new Promise<void>((resolve) => { releaseDelivery = resolve; });
    const entered = new Promise<void>((resolve) => { deliveryEntered = resolve; });
    c.sendMessage.mockImplementation(async (body: any) => {
      if (body.text === `first final ${mode}`) { deliveryEntered(); await delivery; }
      return { ok: true, result: { message_id: 1 } };
    });
    const executed: string[] = [];
    const firstResult = JSON.stringify({ result: `first final ${mode}`, session_id: "first-final" });
    const secondResult = JSON.stringify({ result: `second turn ${mode}`, session_id: "second-turn" });
    const engine = new BridgeEngine({
      ...options("claude"), busyMessageMode: "augment", asyncEnabled,
      hooks: { onAfterExecute: async (prompt: string) => { executed.push(prompt); } },
    }, db, c, {
      runCli: vi.fn().mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult),
      runCliAsync: vi.fn().mockResolvedValueOnce({ text: firstResult }).mockResolvedValueOnce({ text: secondResult }),
    });

    const execution = engine.handleMessages([message(`first request ${mode}`, 7)]);
    await entered;
    const separate = engine.handleMessages([message(`new turn ${mode}`, 7)]);
    releaseDelivery();
    await Promise.all([execution, separate]);

    expect(executed).toEqual([`first request ${mode}`, `new turn ${mode}`]);
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === `first final ${mode}`)).toHaveLength(1);
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === `second turn ${mode}`)).toHaveLength(1);
    db.close();
  });

  it("does not finalize an async run when cancellation wins during output upload", async () => {
    const db = openDb(":memory:", { serviceId: "telegram:interactive", runId: "upload-cancel" });
    const c = client();
    const chatKey = "100:7";
    db.setSession(chatKey, "claude", "previous-session");
    db.addConvTurn(chatKey, "user", "previous request", "claude");
    db.addConvTurn(chatKey, "assistant", "previous answer", "claude");
    db.addMemory({ id: "upload-previous-memory", type: "decision", scope: "project", text: "previous upload memory" });
    const turnsBefore = db.getConvTurnsForCompaction(chatKey).map(({ role, text, cli }) => ({ role, text, cli }));
    const memoryCountBefore = db.getMemoryCount();
    let releaseUpload!: () => void;
    let uploadEntered!: () => void;
    const uploadBarrier = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const uploadStarted = new Promise<void>((resolve) => { uploadEntered = resolve; });
    const uploadSpy = vi.spyOn(fileOutput, "uploadOutputFiles").mockImplementation(async () => {
      uploadEntered();
      await uploadBarrier;
    });
    const firstResult = JSON.stringify({ result: "cancelled during upload", session_id: "cancelled-session" });
    const nextRun = vi.fn().mockResolvedValue({ text: JSON.stringify({ result: "resumed", session_id: "resumed-session" }) });
    const engine = new BridgeEngine({ ...options("claude"), asyncEnabled: true }, db, c, {
      runCliAsync: vi.fn().mockResolvedValueOnce({ text: firstResult }).mockImplementationOnce(nextRun),
    });

    const execution = engine.handleMessages([message("first upload turn", 7)]);
    await uploadStarted;
    const stopping = engine.handleUpdate({ update_id: 702, message: message("/stop", 7) });
    await waitForCondition(() => (engine as any).laneCoordinator.hasCancellation(JSON.stringify(["telegram:interactive", chatKey])));
    releaseUpload();
    await Promise.all([execution, stopping]);

    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "cancelled during upload")).toBe(false);
    expect(db.getSession(chatKey, "claude")).toBe("previous-session");
    expect(db.getConvTurnsForCompaction(chatKey).map(({ role, text, cli }) => ({ role, text, cli }))).toEqual(turnsBefore);
    expect(db.getMemoryCount()).toBe(memoryCountBefore);
    const runs = db.raw.prepare("SELECT run_id, status FROM bridge_runs").all() as Array<{ run_id: string; status: string }>;
    expect(runs.every((run) => run.status !== "done")).toBe(true);
    expect(runs.flatMap((run) => db.getEventsForRun(run.run_id)).some((event) => event.type === "run.completed")).toBe(false);

    uploadSpy.mockResolvedValue(undefined);
    await engine.handleMessages([message("resume after upload cancellation", 7)]);
    expect(nextRun).toHaveBeenCalled();
    expect(db.getSession(chatKey, "claude")).toBe("resumed-session");
    db.close();
  });

  it("does not let a displaced run delete its claimed row before the successor reclaims it", () => {
    const path = join(tmpdir(), `claim-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "must survive", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA)!;
    now += 101;
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    expect(runA.completePendingMsg(handleA, claimed.id)).toBe(false);
    expect(runB.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    expect(runB.claimNextPendingMsg(handleB)?.prompt).toBe("must survive");
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("returns a fenced queued outcome and preserves the row until successor recovery", async () => {
    const path = join(tmpdir(), `queued-outcome-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const handleA = runA.acquireLock("telegram:interactive", "100:7")!;
    runA.enqueueMsg("telegram:interactive", "100:7", { prompt: "claimed work", chatId: 100, threadId: 7, chatType: "private" });
    const claimed = runA.claimNextPendingMsg(handleA)!;
    let resume!: (value: string) => void;
    const paused = new Promise<string>((resolve) => { resume = resolve; });
    const engine = new BridgeEngine(options("claude"), runA, client(), { runCli: () => paused });
    const execution = engine.executeClaimedMessage({ ...claimed, laneHandle: handleA });
    await new Promise((r) => setTimeout(r, 20)); now += 101;
    expect(runB.acquireLock("telegram:interactive", "100:7")).not.toBeNull();
    resume(JSON.stringify({ result: "stale", session_id: "stale" }));
    await expect(execution).resolves.toBe("fenced");
    expect(runB.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("executes a recovered durable row before a new arrival and preserves its attachment", async () => {
    const path = join(tmpdir(), `restart-fifo-${Date.now()}-${Math.random()}.sqlite`);
    const attachment = join(tmpdir(), `queued-attachment-${Date.now()}.txt`);
    writeFileSync(attachment, "durable attachment");
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", {
      prompt: "oldest after restart", chatId: 100, threadId: 7, chatType: "private", attachments: [attachment],
    });
    const seen: Array<{ prompt: string; hasAttachment: boolean }> = [];
    const engine = new BridgeEngine(options("claude"), db, client(), {
      runCli: vi.fn().mockImplementation(async (_command: string, args: string[], _cwd: string, cliOptions: any) => {
        const prompt = `${args.join(" ")} ${cliOptions?.stdin ?? ""}`;
        seen.push({ prompt, hasAttachment: prompt.includes("ZHVyYWJsZSBhdHRhY2htZW50") });
        return "ok";
      }),
    });
    await engine.handleMessages([message("new arrival", 7)]);
    expect(seen.map((entry) => entry.prompt.includes("oldest after restart") ? "oldest" : "new")).toEqual(["oldest", "new"]);
    expect(seen[0].hasAttachment).toBe(true);
    expect(existsSync(attachment)).toBe(false);
    db.close(); rmSync(path, { force: true }); rmSync(attachment, { force: true });
  });

  it("persists a downloaded busy-lane attachment and delivers it after the lane becomes free", async () => {
    const path = join(tmpdir(), `busy-attachment-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    const blockingHandle = db.acquireLock("telegram:interactive", "100:7")!;
    const c = client();
    c.getFilePath = vi.fn().mockResolvedValue("documents/queued.txt");
    c.downloadFile = vi.fn().mockImplementation(async (_remote: string, destination: string) => {
      writeFileSync(destination, "queued document payload");
    });
    let cliInput = "";
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[], _cwd: string, cliOptions: any) => {
      cliInput = `${args.join(" ")} ${cliOptions?.stdin ?? ""}`;
      return "processed attachment";
    });
    const engine = new BridgeEngine(options("claude"), db, c, { runCli });
    const attached = message("inspect this document", 7);
    attached.document = { file_id: "queued-file", file_name: "queued.txt", mime_type: "text/plain", file_size: 23 };

    await engine.handleMessages([attached]);
    const queued = db.dequeueMsgs("telegram:interactive", "100:7");
    expect(queued).toHaveLength(1);
    expect(queued[0].attachments).toHaveLength(1);
    const queuedPath = queued[0].attachments[0];
    expect(existsSync(queuedPath)).toBe(true);
    expect(runCli).not.toHaveBeenCalled();

    db.unlock(blockingHandle);
    await engine.recoverPendingQueues();
    expect(runCli).toHaveBeenCalledOnce();
    expect(cliInput).toContain(Buffer.from("queued document payload").toString("base64"));
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect(existsSync(queuedPath)).toBe(false);
    db.close(); rmSync(path, { force: true });
  });

  it("retries the oldest row before later arrivals after a queue handoff failure", async () => {
    const path = join(tmpdir(), `handoff-retry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "oldest", chatId: 100, threadId: 7, chatType: "private" });
    const order: string[] = [];
    let failOnce = true;
    let engine!: BridgeEngine;
    engine = new BridgeEngine(options("claude", {
      onQueuedMessage: async (queued: any) => {
        if (failOnce) { failOnce = false; throw new Error("router unavailable"); }
        return engine.executeClaimedMessage(queued);
      },
    }), db, client(), {
      runCli: vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        const prompt = String(args.at(-1));
        order.push(prompt.includes("oldest") ? "oldest" : prompt.includes("arrival one") ? "one" : "two");
        return "ok";
      }),
    });
    await engine.handleMessages([message("arrival one", 7)]);
    expect(order).toEqual([]);
    await engine.handleMessages([message("arrival two", 7)]);
    expect(order).toEqual(["oldest", "one", "two"]);
    db.close(); rmSync(path, { force: true });
  });

  it("automatically resumes durable queued work on startup without a new message", async () => {
    const path = join(tmpdir(), `startup-recovery-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "recover on startup", chatId: 100, threadId: 7, chatType: "private" });
    const runCli = vi.fn().mockResolvedValue("recovered");
    const engine = new BridgeEngine(options("claude"), db, client(), { runCli });
    await engine.recoverPendingQueues();
    expect(runCli).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("automatically retries a transient queue-router failure without a new message", async () => {
    const path = join(tmpdir(), `router-retry-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    db.setSetting("ctx_suppress:100:7", "1");
    db.enqueueMsg("telegram:interactive", "100:7", { prompt: "retry automatically", chatId: 100, threadId: 7, chatType: "private" });
    const runCli = vi.fn().mockResolvedValue("recovered");
    let failOnce = true;
    let engine!: BridgeEngine;
    engine = new BridgeEngine(options("claude", {
      onQueuedMessage: async (queued: any) => {
        if (failOnce) { failOnce = false; throw new Error("transient router failure"); }
        return engine.executeClaimedMessage(queued);
      },
    }), db, client(), { runCli });
    await engine.recoverPendingQueues();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runCli).toHaveBeenCalledOnce();
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close(); rmSync(path, { force: true });
  });

  it("renews and fences atomically after parsing before the first state mutation", async () => {
    const path = join(tmpdir(), `commit-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const c = client();
    const original = (runA as any).runWithLockFence?.bind(runA);
    (runA as any).runWithLockFence = (handle: any, operation: () => unknown) => {
      now += 101;
      expect(runB.acquireLock(handle.surface, handle.chatKey)).not.toBeNull();
      return original(handle, operation);
    };
    const engine = new BridgeEngine(options("claude"), runA, c, {
      runCli: vi.fn().mockResolvedValue(JSON.stringify({ result: "parsed but fenced", session_id: "must-not-store" })),
    });
    await engine.handleMessages([message("race commit", 7)]);
    expect(runB.getSession("100:7", "claude")).toBeNull();
    expect(runB.getConvTurnsForCompaction("100:7")).toHaveLength(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => String(call[0].text).includes("parsed but fenced"))).toBe(false);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("fences post-compaction session reset and success notification", async () => {
    const path = join(tmpdir(), `compact-publish-fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    runA.addConvTurn("100:7", "user", "compact me");
    runA.setSession("100:7", "claude", "keep-on-fence");
    const c = client();
    const original = (runA as any).runWithLockFence?.bind(runA);
    (runA as any).runWithLockFence = (handle: any, operation: () => unknown) => {
      now += 101;
      expect(runB.acquireLock(handle.surface, handle.chatKey)).not.toBeNull();
      return original(handle, operation);
    };
    const engine = new BridgeEngine(options("claude"), runA, c, {
      runCli: vi.fn().mockResolvedValue('{"summary_md":"safe summary","memory_candidates":[]}'),
    });
    await expect(engine.handleMessages([message("/compact", 7)])).rejects.toThrow();
    expect(runB.getSession("100:7", "claude")).toBe("keep-on-fence");
    expect(c.sendMessage.mock.calls.some((call: any[]) => String(call[0].text).includes("Context compacted"))).toBe(false);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("fences a displaced run before it publishes or commits conversation state", async () => {
    const path = join(tmpdir(), `fence-${Date.now()}-${Math.random()}.sqlite`);
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "telegram:interactive", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "telegram:interactive", runId: "b", lockLeaseMs: 100, clock: () => now });
    const c = client(); let resume!: (value: string) => void;
    const paused = new Promise<string>((resolve) => { resume = resolve; });
    const engineA = new BridgeEngine(options("claude"), runA, c, { runCli: () => paused });
    const active = engineA.handleMessages([message("old run", 7)]);
    await new Promise((r) => setTimeout(r, 20)); now += 101;
    const handleB = runB.acquireLock("telegram:interactive", "100:7")!;
    expect(handleB).not.toBeNull();
    resume(JSON.stringify({ result: "stale output", session_id: "stale-session" })); await active;
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0].text === "stale output")).toBe(false);
    expect(runB.getSession("100:7", "claude")).toBeNull();
    expect(runB.ownsLock(handleB)).toBe(true);
    runA.close(); runB.close(); rmSync(path, { force: true });
  });

  it("documents guarded rollout and quarantine", () => {
    const doc = readFileSync(join(process.cwd(), "docs", "execution-lane-rollout.md"), "utf8");
    expect(doc).toMatch(/stop-all.*migrate.*start-all/is);
    expect(doc).toMatch(/legacy queue count/i); expect(doc).toMatch(/explicit discard decision/i);
    expect(doc).toMatch(/flat private-chat history.*quarantin/is); expect(doc).toMatch(/separate approval/i);
    expect(doc).toMatch(/BRIDGE_WORKSPACE_LOCK_MODE=off/is);
    expect(doc).toMatch(/isolated per-job worktrees/is);
  });
});
