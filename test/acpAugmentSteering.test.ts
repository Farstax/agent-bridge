import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { isAbortRequested, shutdownCliProcessesAndWait } from "../src/cli.js";

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

function options() {
  return {
    surfaceIdentity: "telegram:interactive",
    kind: "claude",
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe" as const,
    busyMessageMode: "augment" as const,
    pollIntervalMs: 1000,
    workingDir: process.cwd(),
    hooks: {},
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

afterEach(async () => {
  await shutdownCliProcessesAndWait();
  vi.restoreAllMocks();
});

describe("ACP steering as the augment primitive (issue #748)", () => {
  it("injects the augmenting message into the live turn instead of cancelling and restarting", async () => {
    const dbPath = join(tmpdir(), `acp-steer-augment-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const steerCalls: string[] = [];

    const mockRunProviderInvocation = vi.fn().mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
      opts.onSteerReady?.(async (prompt: string) => {
        steerCalls.push(prompt);
        return { outcome: "injected" };
      });
      firstStarted.release();
      await firstGate.promise;
      return { text: "first final", sessionId: "first-session" };
    });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => steerCalls.length > 0);
    firstGate.release();
    await Promise.all([first, second]);

    expect(steerCalls).toEqual(["second request"]);
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(1);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.augmentedTaskCount()).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "first final")).toBe(true);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("stops steering further rounds, without falsely reporting full success, if the execution lease is lost mid-loop", async () => {
    const dbPath = join(tmpdir(), `acp-steer-lease-lost-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const steerCalls: string[] = [];

    // Simulates losing execution-lease ownership between claiming this
    // round's rows and completing them (e.g. a heartbeat failure): the
    // round's own injection already happened at the provider, but Bridge
    // can no longer safely trust this handle for a further round.
    const completeSpy = vi.spyOn(db, "completePendingMsgs").mockReturnValueOnce(false);

    const mockRunProviderInvocation = vi.fn().mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
      opts.onSteerReady?.(async (prompt: string) => {
        steerCalls.push(prompt);
        return { outcome: "injected" };
      });
      firstStarted.release();
      await firstGate.promise;
      return { text: "first final", sessionId: "first-session" };
    });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => steerCalls.length > 0);
    firstGate.release();
    await Promise.all([first, second]);

    // Exactly one round attempted: the failed completion must stop the
    // loop rather than looping again (which would re-claim/re-steer
    // whatever else was queued against a handle that may no longer be
    // valid, or silently mask the lease loss).
    expect(steerCalls).toEqual(["second request"]);
    expect(completeSpy).toHaveBeenCalledTimes(1);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("steers multiple rapid augments in arrival order into the same live turn, never restarting", async () => {
    const dbPath = join(tmpdir(), `acp-steer-multi-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const firstSteerEntered = signal();
    const firstSteerGate = signal();
    const steerCalls: string[] = [];

    const mockRunProviderInvocation = vi.fn().mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
      let steerCallCount = 0;
      opts.onSteerReady?.(async (prompt: string) => {
        steerCalls.push(prompt);
        steerCallCount += 1;
        if (steerCallCount === 1) {
          // Hold the first steer RPC open so a second augment can arrive
          // and durably queue itself while it's still in flight.
          firstSteerEntered.release();
          await firstSteerGate.promise;
        }
        return { outcome: "injected" };
      });
      firstStarted.release();
      await firstGate.promise;
      return { text: "first final", sessionId: "first-session" };
    });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await firstSteerEntered.promise;
    // Third message arrives while the first augment's steering RPC is still
    // in flight. Before the fix, _cancelLane's dedup just returns the
    // existing in-flight promise and never re-attempts steering for this
    // one — it would sit queued until the turn finishes naturally instead
    // of being steered in arrival order like "second request" was.
    const third = engine.handleMessages([message("third request")]);
    await waitForCondition(() => db.pendingMsgCount("telegram:interactive", "100:7") >= 3);
    firstSteerGate.release();
    firstGate.release();
    await Promise.all([first, second, third]);

    expect(steerCalls).toEqual(["second request", "third request"]);
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(1);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("falls back to cancel+restart, without losing or duplicating the message, when the steering RPC itself throws", async () => {
    const dbPath = join(tmpdir(), `acp-steer-error-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const steerCalls: string[] = [];

    const mockRunProviderInvocation = vi.fn()
      .mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
        opts.onSteerReady?.(async (prompt: string) => {
          steerCalls.push(prompt);
          throw new Error("transport closed mid-request");
        });
        firstStarted.release();
        await firstGate.promise;
        return { text: "first final", sessionId: "first-session" };
      })
      .mockResolvedValueOnce({ text: "second final", sessionId: "second-session" });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => steerCalls.length > 0);
    firstGate.release();
    await Promise.all([first, second]);

    expect(steerCalls).toEqual(["second request"]);
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(2);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.augmentedTaskCount()).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "second final")).toBe(true);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("never resubmits the same content when steering returns startedNewTurn — fences the lane instead of falling back to cancel+restart", async () => {
    const dbPath = join(tmpdir(), `acp-steer-anomaly-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const steerCalls: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Only one implementation queued: if the fix regresses back to
    // "fall back to cancel+restart", a second invocation would resubmit the
    // same content the provider may have already started acting on — the
    // exact duplicate-side-effect risk #748 was blocked on for Codex. A
    // second call here has no mock response and the test times out/throws,
    // making that regression fail loudly rather than silently pass.
    const mockRunProviderInvocation = vi.fn().mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
      opts.onSteerReady?.(async (prompt: string) => {
        steerCalls.push(prompt);
        return { outcome: "startedNewTurn" };
      });
      firstStarted.release();
      await firstGate.promise;
      return { text: "first final", sessionId: "first-session" };
    });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => steerCalls.length > 0);
    firstGate.release();
    await Promise.all([first, second]);

    expect(steerCalls).toEqual(["second request"]);
    // Fail closed: never resubmit content the provider may have already
    // started acting on in a detached, Bridge-unowned turn.
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(1);
    // Not silently lost either — discarded (not left stuck forever), and
    // the anomaly is surfaced loudly so it's not a silent drop.
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("startedNewTurn"))).toBe(true);

    errorSpy.mockRestore();
    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("falls back to cancel+restart when steering reports promptRequired (turn already idle)", async () => {
    const dbPath = join(tmpdir(), `acp-steer-fallback-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const firstGate = signal();
    const steerCalls: string[] = [];

    const mockRunProviderInvocation = vi.fn()
      .mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
        opts.onSteerReady?.(async (prompt: string) => {
          steerCalls.push(prompt);
          return { outcome: "promptRequired", reason: "noRunningTurn" };
        });
        firstStarted.release();
        await firstGate.promise;
        return { text: "first final", sessionId: "first-session" };
      })
      .mockResolvedValueOnce({ text: "second final", sessionId: "second-session" });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await waitForCondition(() => steerCalls.length > 0);
    firstGate.release();
    await Promise.all([first, second]);

    expect(steerCalls).toEqual(["second request"]);
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(2);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.augmentedTaskCount()).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);
    expect(c.sendMessage.mock.calls.some((call: any[]) => call[0]?.text === "second final")).toBe(true);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);

  it("lets /stop win a race against an in-flight steering RPC instead of silently absorbing it as a completed augment", async () => {
    const dbPath = join(tmpdir(), `acp-steer-stop-race-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath);
    const c = client();
    const firstStarted = signal();
    const steerEntered = signal();
    const steerGate = signal();
    const steerCalls: string[] = [];
    let lane: string | number | undefined;

    const mockRunProviderInvocation = vi.fn().mockImplementationOnce(async (_bot: string, _invocation: any, _cwd: string, opts: any) => {
      lane = opts.chatId;
      opts.onSteerReady?.(async (prompt: string) => {
        steerCalls.push(prompt);
        steerEntered.release();
        await steerGate.promise;
        return { outcome: "injected" };
      });
      firstStarted.release();
      // Simulates a real provider turn honoring abort/kill once /stop's
      // fallback path actually reaches it, rather than hanging forever.
      while (!(lane != null && isAbortRequested(lane))) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { text: "aborted", sessionId: "first-session" };
    });

    const engine = new BridgeEngine(
      options(),
      db,
      c,
      { runProviderInvocation: mockRunProviderInvocation },
    );

    const first = engine.handleMessages([message("first request")]);
    await firstStarted.promise;
    const second = engine.handleMessages([message("second request")]);
    await steerEntered.promise;
    const stop = (engine as any)._cancelLane("100:7", "stop");
    steerGate.release();
    await Promise.all([first, second, stop]);

    expect(steerCalls).toEqual(["second request"]);
    // The race must not be silently absorbed as a completed augment: /stop's
    // discard semantics win, so the augmenting message is dropped, not
    // executed a second time and not left stranded in the queue.
    expect(mockRunProviderInvocation).toHaveBeenCalledTimes(1);
    expect(db.pendingMsgCount("telegram:interactive", "100:7")).toBe(0);
    expect((engine as any).laneCoordinator.cancellationCount()).toBe(0);

    db.close();
    rmSync(dbPath, { force: true });
  }, 8_000);
});
