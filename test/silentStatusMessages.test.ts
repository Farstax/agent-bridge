import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { shutdownCliProcessesAndWait } from "../src/cli.js";

// Regression coverage for Issue #229: the interstitial "🔄 Updating the
// active task...", "⏳ Queued (position N of 5)...", and "▶️ Processing
// your queued message..." notices are removed. Augment/queue/recovery
// admission, cancellation, and coalescing must keep working exactly as
// before — only the narration disappears. Actionable messages (queue-full,
// explicit /stop, execution failures, interrupt-mode feedback, final
// answers) must be unaffected.

function message(text: string, threadId: number | undefined = 7) {
  return {
    message_id: Math.random(),
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "T" },
    message_thread_id: threadId,
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

function options(mode: "augment" | "interrupt" | "queue", overrides: any = {}) {
  return {
    surfaceIdentity: "telegram:interactive",
    kind: "claude",
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe" as const,
    busyMessageMode: mode === "queue" ? "queue" : mode,
    asyncEnabled: false,
    pollIntervalMs: 1000,
    ...overrides,
  };
}

function signal() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function anyStatusNoise(c: ReturnType<typeof client>): boolean {
  return c.sendMessage.mock.calls.some((call: any[]) => {
    const text = call[0]?.text;
    return typeof text === "string" && (
      text.includes("Updating the active task") ||
      text.includes("Queued (position") ||
      text.includes("Processing your queued message")
    );
  });
}

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.restoreAllMocks();
});

describe("Issue #229: silent queue/augment admission", () => {
  it("1. augment admission sends no status message", async () => {
    const db = openDb(":memory:");
    const c = client();
    const firstStarted = signal();
    let resolveFirst!: (value: string) => void;
    const firstCli = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const mockRunCli = vi.fn()
      .mockImplementationOnce(async () => { firstStarted.release(); return firstCli; })
      .mockResolvedValueOnce('{"result":"merged result","session_id":"merged-session"}');

    const engine = new BridgeEngine(options("augment"), db, c, { runCli: mockRunCli });

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => mockRunCli.mock.calls.length >= 1);
    resolveFirst('{"result":"first final","session_id":"first-session"}');
    await Promise.all([first, second]);

    expect(anyStatusNoise(c)).toBe(false);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "🔄 Updating the active task...")).toBe(false);
    db.close();
  }, 8_000);

  it("2. normal queued admission sends no queue-position message", async () => {
    const db = openDb(":memory:");
    const c = client();
    // Hold the lane lock externally to force plain FIFO queueing.
    db.acquireLock("telegram:interactive", "100:7");

    const engine = new BridgeEngine(options("queue"), db, c, {});
    await engine.handleMessages([message("queued while busy")]);

    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(1);
    expect(c.sendMessage).not.toHaveBeenCalled();
    expect(anyStatusNoise(c)).toBe(false);
    db.close();
  });

  it("3. recovery of an older queued message sends no processing message", async () => {
    const db = openDb(":memory:");
    const c = client();
    // Simulate a message left over from a prior crashed/interrupted run: it
    // sits in pending_messages with no lock held, so the next admission can
    // both enqueue its own message and claim+drain the older one in the same
    // call (admission.kind === "execute_claimed").
    db.enqueueMsg("telegram:interactive", "100:7", {
      prompt: "orphaned older message", chatId: 100, threadId: 7, chatType: "private",
    });
    const mockRunCli = vi.fn()
      .mockResolvedValueOnce('{"result":"older answer","session_id":"older-session"}')
      .mockResolvedValueOnce('{"result":"newer answer","session_id":"newer-session"}');

    const engine = new BridgeEngine(options("queue"), db, c, { runCli: mockRunCli });
    await engine.handleMessages([message("newer message")]);
    await waitForCondition(() => db.pendingMsgCount("telegram:interactive", "100:7") === 0);

    expect(anyStatusNoise(c)).toBe(false);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "older answer")).toBe(true);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "newer answer")).toBe(true);
    db.close();
  }, 8_000);

  it("4. final answers and actionable failures are still delivered", async () => {
    const db = openDb(":memory:");
    const c = client();
    const mockRunCli = vi.fn().mockResolvedValueOnce('{"result":"solo answer","session_id":"solo-session"}');
    const engine = new BridgeEngine(options("queue"), db, c, { runCli: mockRunCli });
    await engine.handleMessages([message("solo request")]);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "solo answer")).toBe(true);

    // Queue-full remains an actionable message (kept per Issue #229 scope).
    const busyDb = openDb(":memory:");
    const busyClient = client();
    busyDb.acquireLock("telegram:interactive", "100:9");
    for (let i = 0; i < 5; i++) {
      busyDb.enqueueMsg("telegram:interactive", "100:9", {
        prompt: `backlog ${i}`, chatId: 100, threadId: 9, chatType: "private",
      });
    }
    const busyEngine = new BridgeEngine(options("queue"), busyDb, busyClient, {});
    await busyEngine.handleMessages([message("one too many", 9)]);
    expect(busyClient.sendMessage.mock.calls.some((call: any[]) => call[0]?.text?.includes("Queue is full"))).toBe(true);

    db.close();
    busyDb.close();
  });

  it("5. augment cancellation and coalescing behaviour is unchanged", async () => {
    const dbPath = join(tmpdir(), `augment-coalesce-silent-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const prompts: string[] = [];
    const firstStarted = signal();
    let resolveFirst!: (value: string) => void;
    const firstCli = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const mockRunCli = vi.fn()
      .mockImplementationOnce(async () => { firstStarted.release(); return firstCli; })
      .mockResolvedValueOnce('{"result":"merged answer","session_id":"merged-session"}');

    const engine = new BridgeEngine(
      options("augment", { hooks: { onBeforeExecute: async (prompt: string) => { prompts.push(prompt); return prompt; } } }),
      db, c, { runCli: mockRunCli },
    );

    const first = engine.handleMessages([message("first ask")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second ask")]);
    resolveFirst('{"result":"first final","session_id":"first-session"}');
    await Promise.all([first, second]);

    // Coalescing behaviour unchanged: the merged execution receives both
    // prompts joined, exactly as before this hotfix — only the notice text
    // is gone.
    expect(mockRunCli).toHaveBeenCalledTimes(2);
    expect(prompts[prompts.length - 1]).toBe("first ask\n\nsecond ask");
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "merged answer")).toBe(true);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);
    expect((engine as any).laneCoordinator.augmentedTaskCount()).toBe(0);
    expect(anyStatusNoise(c)).toBe(false);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);
});
