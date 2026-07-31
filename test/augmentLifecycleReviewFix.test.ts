import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { runCli, shutdownCliProcessesAndWait } from "../src/cli.js";

function message(text: string) {
  return {
    message_id: Math.random(),
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "T" },
    message_thread_id: 7,
    text,
  } as any;
}

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn(),
    sendDocument: vi.fn(),
    getUpdates: vi.fn(),
    setMyCommands: vi.fn(),
    answerCallbackQuery: vi.fn(),
    editMessageText: vi.fn(),
  } as any;
}

function options(mode: "augment" | "interrupt", hooks: any = {}) {
  return {
    surfaceIdentity: "telegram:interactive",
    kind: "claude",
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe" as const,
    busyMessageMode: mode,
    asyncEnabled: false,
    pollIntervalMs: 1000,
    hooks,
  };
}

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
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
  vi.restoreAllMocks();
});

describe("augment lifecycle review regressions", () => {
  it("explicit interrupt runs only the interrupting prompt", async () => {
    const dbPath = join(tmpdir(), `interrupt-latest-${Date.now()}-${Math.random()}.sqlite`);
    const ready = join(tmpdir(), `interrupt-latest-ready-${Date.now()}-${Math.random()}`);
    const db = openDb(dbPath);
    const c = client();
    const prompts: string[] = [];
    const mockRunCli = vi.fn()
      .mockImplementationOnce((_command, _args, cwd, cliOptions) => runCli(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ready'); setTimeout(()=>{},10000)", ready],
        cwd,
        cliOptions,
      ))
      .mockResolvedValueOnce('{"result":"latest result","session_id":"latest-session"}');
    const engine = new BridgeEngine(
      options("interrupt", { onBeforeExecute: async (prompt: string) => { prompts.push(prompt); return prompt; } }),
      db,
      c,
      { runCli: mockRunCli },
    );

    const original = engine.handleMessages([message("cancelled original")]);
    await waitForFile(ready);
    const interrupt = engine.handleMessages([message("latest instruction")]);
    await Promise.all([original, interrupt]);

    // Queued successors pass through the hook at admission and again at claim.
    expect(prompts).toEqual(["cancelled original", "latest instruction", "latest instruction"]);
    expect(mockRunCli).toHaveBeenCalledTimes(2);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect(c.sendMessage.mock.calls.filter((call: any[]) => call[0]?.text === "latest result")).toHaveLength(1);
    db.close();
    rmSync(dbPath, { force: true });
    rmSync(ready, { force: true });
  }, 8_000);

  it("clears cancellation ownership when augment admission races final delivery", async () => {
    const db = openDb(":memory:");
    const c = client();
    const noticeEntered = signal();
    const noticeGate = signal();
    const finalEntered = signal();
    const finalGate = signal();
    const firstCliStarted = signal();
    let resolveFirstCli!: (value: string) => void;
    const firstCli = new Promise<string>((resolve) => { resolveFirstCli = resolve; });

    c.sendMessage.mockImplementation(async (body: any) => {
      if (body.text === "first final") {
        finalEntered.release();
        await finalGate.promise;
      }
      return { ok: true, result: { message_id: 1 } };
    });

    const prompts: string[] = [];
    const mockRunCli = vi.fn()
      .mockImplementationOnce(async () => {
        firstCliStarted.release();
        return firstCli;
      })
      .mockResolvedValueOnce('{"result":"second final","session_id":"second-session"}')
      .mockResolvedValueOnce('{"result":"third final","session_id":"third-session"}');
    const engine = new BridgeEngine(
      options("augment", { onBeforeExecute: async (prompt: string) => { prompts.push(prompt); return prompt; } }),
      db,
      c,
      { runCli: mockRunCli },
    );

    // The augment notice message is gone (Issue #229 — silent augment), but the
    // race this test proves still needs a synchronization point at the same
    // spot: the moment admission decides to fold into the active task and
    // calls _cancelLane, before the active turn's own final delivery lands.
    const originalCancelLane = (engine as any)._cancelLane.bind(engine);
    vi.spyOn(engine as any, "_cancelLane").mockImplementation(async (...args: any[]) => {
      if (args[1] === "augment") {
        noticeEntered.release();
        await noticeGate.promise;
      }
      return originalCancelLane(...args);
    });

    const first = engine.handleMessages([message("first request")]);
    await firstCliStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await noticeEntered.promise;
    resolveFirstCli('{"result":"first final","session_id":"first-session"}');
    await finalEntered.promise;
    noticeGate.release();
    await waitForCondition(() => (engine as any).cancellationOperations.size === 1);
    finalGate.release();
    await Promise.all([first, second]);

    expect(prompts).toEqual(["first request", "second request", "second request"]);
    expect((engine as any).cancellationOperations.size).toBe(0);
    expect((engine as any).activeAugmentedTasks.size).toBe(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "🔄 Updating the active task...")).toBe(false);

    await engine.handleMessages([message("third request")]);
    expect(prompts).toEqual(["first request", "second request", "second request", "third request"]);
    expect(mockRunCli).toHaveBeenCalledTimes(3);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    db.close();
  }, 8_000);
});
