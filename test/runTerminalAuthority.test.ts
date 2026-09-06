import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import { type as eventType } from "../src/events/types.js";
import { BridgeEngine } from "../src/engine.js";
import {
  acceptRunIngressRequest,
  executeRunIngressRequest,
  type RunIngressEngine,
  type RunIngressRequest,
} from "../src/runIngress.js";

const paths: string[] = [];

function sqlitePath(prefix: string): string {
  const path = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  paths.push(path);
  return path;
}

function makeMessage(text: string) {
  return {
    message_id: Math.floor(Math.random() * 10_000),
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeClient() {
  return {
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      passiveSurroundingContext: false,
      formatting: "telegram-html",
    },
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function request(overrides: Partial<RunIngressRequest> = {}): RunIngressRequest {
  return {
    requestId: "request-1",
    idempotencyKey: "caller:request-1",
    scopeKey: "workspace-1",
    prompt: "Inspect the bounded problem and report the next action.",
    token: "trusted-ingress-token",
    ...overrides,
  };
}

function injectTerminalWriteFailure(db: ReturnType<typeof openDb>): void {
  db.raw.exec(`
    CREATE TRIGGER reject_terminal_done
    BEFORE UPDATE ON bridge_runs
    WHEN NEW.status = 'done'
    BEGIN
      SELECT RAISE(ABORT, 'injected terminal persistence failure');
    END;
  `);
}

afterEach(() => {
  for (const path of paths.splice(0)) {
    try { rmSync(path); } catch { /* already removed */ }
    try { rmSync(`${path}-wal`); } catch { /* optional */ }
    try { rmSync(`${path}-shm`); } catch { /* optional */ }
  }
});

describe("durable Run terminal authority", () => {
  it("does not treat an attempt-level run.failed as the Run terminal outcome", () => {
    const db = openDb(sqlitePath("attempt-failure"));
    const store = new EventStore(db);
    const started = eventType.runStarted({
      runId: "r-fallback",
      bot: "claude",
      chatId: "100",
      chatKey: "100",
      command: "claude",
      cwd: "/",
      model: "claude-primary",
    });
    const attemptFailed = eventType.runFailed({
      runId: "r-fallback",
      bot: "claude",
      chatId: "100",
      chatKey: "100",
      error: "rate limit capacity exhausted",
      category: "cli",
    });
    store.collect(started);
    store.collect(attemptFailed);

    expect(db.getRun("r-fallback").status).toBe("running");
    expect(db.getEventsForRun("r-fallback").map((event) => event.type)).toEqual(["run.started", "run.failed"]);

    store.queueCompleted(eventType.runCompleted({
      runId: "r-fallback",
      bot: "claude",
      chatId: "100",
      chatKey: "100",
      text: "fallback answer",
      sessionId: "s-2",
    }));
    store.finalize();

    expect(db.getRun("r-fallback")).toMatchObject({ status: "done", session_id: "s-2" });
    expect(db.getEventsForRun("r-fallback").filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(db.getEventsForRun("r-fallback").filter((event) => event.type === "run.failed")).toHaveLength(1);
    db.close();
  });

  it("settles failed exactly once after finalize when no completion was queued", () => {
    const db = openDb(sqlitePath("all-attempts-failed"));
    const store = new EventStore(db);
    store.collect(eventType.runStarted({
      runId: "r-exhausted",
      bot: "claude",
      chatId: "100",
      chatKey: "100",
      command: "claude",
      cwd: "/",
      model: null,
    }));
    store.collect(eventType.runFailed({
      runId: "r-exhausted",
      bot: "claude",
      chatId: "100",
      chatKey: "100",
      error: "rate limit capacity exhausted",
      category: "cli",
    }));
    expect(db.getRun("r-exhausted").status).toBe("running");
    store.finalize();
    expect(db.getRun("r-exhausted")).toMatchObject({ status: "failed", error: "rate limit capacity exhausted" });
    expect(db.getEventsForRun("r-exhausted").filter((event) => event.type === "run.failed")).toHaveLength(1);
    db.close();
  });

  it("settles a completed Run when a later message fences final delivery", async () => {
    const path = sqlitePath("fenced-delivery");
    let now = Date.parse("2026-07-15T10:00:00.000Z");
    const runA = openDb(path, { serviceId: "test", runId: "a", lockLeaseMs: 100, clock: () => now });
    const runB = openDb(path, { serviceId: "test", runId: "b", lockLeaseMs: 100, clock: () => now });
    const client = makeClient();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const runCliAsync = vi.fn(async (_command: string, _args: string[], cwd: string, options: any) => {
      const ctx = options.eventContext;
      options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd, model: null }));
      options.onEvent?.(eventType.runCompleted({ ...ctx, text: "finished work", sessionId: null }));
      await paused;
      return { text: JSON.stringify({ type: "result", result: "finished work", session_id: "s-1" }) };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "test",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: ["claude-primary"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
    }, runA, client, { runCliAsync });

    const active = engine.handleMessages([makeMessage("finish this")]);
    await vi.waitFor(() => {
      expect(runCliAsync).toHaveBeenCalled();
    });
    now += 101;
    expect(runB.acquireLock("test", "100")).not.toBeNull();
    release();
    await active;

    const runs = runA.raw.prepare("SELECT run_id, status FROM bridge_runs").all() as Array<{ run_id: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    expect(runA.getEventsForRun(runs[0].run_id).some((event) => event.type === "run.completed")).toBe(true);
    runA.close();
    runB.close();
  });

  it("records a successful same-Run model fallback as done with one completed event", async () => {
    const db = openDb(sqlitePath("model-fallback"));
    const client = makeClient();
    let attempt = 0;
    const runCliAsync = vi.fn(async (_command: string, _args: string[], cwd: string, options: any) => {
      const ctx = options.eventContext;
      attempt += 1;
      if (attempt === 1) {
        options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd, model: "claude-primary" }));
        options.onEvent?.(eventType.runFailed({
          ...ctx,
          error: "rate limit capacity exhausted",
          category: "cli",
        }));
        throw new Error("rate limit capacity exhausted");
      }
      options.onEvent?.(eventType.runStarted({ ...ctx, command: "claude", cwd, model: "claude-fallback" }));
      options.onEvent?.(eventType.runCompleted({ ...ctx, text: "fallback answer", sessionId: "s-2" }));
      return { text: JSON.stringify({ type: "result", result: "fallback answer", session_id: "s-2" }) };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "test",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: ["claude-primary", "claude-fallback"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
    }, db, client, { runCliAsync });

    await engine.handleMessages([makeMessage("need fallback")]);

    const runs = db.raw.prepare("SELECT run_id, status FROM bridge_runs").all() as Array<{ run_id: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("done");
    const events = db.getEventsForRun(runs[0].run_id);
    expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    expect(events.some((event) => event.type === "run.failed")).toBe(true);
    expect(runCliAsync).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("does not acknowledge ingress success when terminal persistence fails", async () => {
    const db = openDb(sqlitePath("ingress-persist-fail"));
    const accepted = acceptRunIngressRequest(db, request(), {
      expectedToken: "trusted-ingress-token",
      runId: () => "run-1",
    });
    injectTerminalWriteFailure(db);
    const engine: RunIngressEngine = {
      executeSurfaceNeutralTurn: async (input) => {
        input.onProviderExecutionStarted?.();
        input.collect(eventType.runStarted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          command: "claude",
          cwd: "/",
          model: null,
        }));
        input.collect(eventType.runCompleted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          text: "bounded result",
          sessionId: null,
        }));
        return { text: "bounded result", sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
      },
    };

    const response = await executeRunIngressRequest(db, accepted.receiptId, engine, { bot: "claude" });
    expect(response).toMatchObject({ runId: "run-1", status: "failed", errorClass: "ambiguous" });
    expect(db.getRun("run-1").status).toBe("running");
    const receipt = db.getEventReceipt(accepted.receiptId);
    expect(receipt.status).not.toBe("completed");
    db.close();
  });

  it("does not invoke the provider again after persistence ambiguity", async () => {
    const db = openDb(sqlitePath("ingress-replay-fence"));
    const accepted = acceptRunIngressRequest(db, request(), {
      expectedToken: "trusted-ingress-token",
      runId: () => "run-1",
    });
    injectTerminalWriteFailure(db);
    let invocations = 0;
    const engine: RunIngressEngine = {
      executeSurfaceNeutralTurn: async (input) => {
        invocations += 1;
        input.onProviderExecutionStarted?.();
        input.collect(eventType.runStarted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          command: "claude",
          cwd: "/",
          model: null,
        }));
        input.collect(eventType.runCompleted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          text: "bounded result",
          sessionId: null,
        }));
        return { text: "bounded result", sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
      },
    };

    await executeRunIngressRequest(db, accepted.receiptId, engine, { bot: "claude" });
    const replay = await executeRunIngressRequest(db, accepted.receiptId, engine, { bot: "claude" });
    expect(invocations).toBe(1);
    expect(replay).toMatchObject({ runId: "run-1", status: "failed", errorClass: "ambiguous" });
    db.close();
  });

  it("does not invoke the provider when execution admission cannot be persisted", async () => {
    const db = openDb(sqlitePath("ingress-admission"));
    const accepted = acceptRunIngressRequest(db, request(), {
      expectedToken: "trusted-ingress-token",
      runId: () => "run-1",
    });
    const originalSetSetting = db.setSetting.bind(db);
    db.setSetting = ((key: string, value: string | null) => {
      if (key.includes("execution-started") && value) {
        throw new Error("injected admission persistence failure");
      }
      return originalSetSetting(key, value);
    }) as typeof db.setSetting;
    let invoked = false;
    const engine: RunIngressEngine = {
      executeSurfaceNeutralTurn: async (input) => {
        input.onProviderExecutionStarted?.();
        invoked = true;
        return { text: "should not run", sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
      },
    };

    const response = await executeRunIngressRequest(db, accepted.receiptId, engine, { bot: "claude" });
    expect(invoked).toBe(false);
    expect(response).toMatchObject({ runId: "run-1", status: "failed" });
    expect(db.getRun("run-1").status).toBe("failed");
    db.close();
  });

  it("fences already-started ingress work after database reopen", async () => {
    const path = sqlitePath("ingress-reopen");
    const db = openDb(path, { serviceId: "test-ingress", runId: "proc-1" });
    const accepted = acceptRunIngressRequest(db, request(), {
      expectedToken: "trusted-ingress-token",
      runId: () => "run-1",
    });
    injectTerminalWriteFailure(db);
    await executeRunIngressRequest(db, accepted.receiptId, {
      executeSurfaceNeutralTurn: async (input) => {
        input.onProviderExecutionStarted?.();
        input.collect(eventType.runStarted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          command: "claude",
          cwd: "/",
          model: null,
        }));
        input.collect(eventType.runCompleted({
          runId: input.runId,
          bot: "claude",
          chatId: input.chatKey,
          chatKey: input.chatKey,
          text: "bounded result",
          sessionId: null,
        }));
        return { text: "bounded result", sessionId: null, memoryCandidates: [], nativeSessionMode: "fresh" };
      },
    }, { bot: "claude" });
    db.close();

    const reopened = openDb(path, { serviceId: "test-ingress", runId: "proc-2" });
    let invoked = false;
    const replay = await executeRunIngressRequest(reopened, accepted.receiptId, {
      executeSurfaceNeutralTurn: async () => {
        invoked = true;
        throw new Error("must not execute");
      },
    }, { bot: "claude" });
    expect(invoked).toBe(false);
    expect(replay).toMatchObject({ runId: "run-1", status: "failed", errorClass: "ambiguous" });
    expect(reopened.getRun("run-1").status).toBe("running");
    reopened.close();
  });
});
