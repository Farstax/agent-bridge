import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import type { TelegramMessage } from "../src/types.js";
import type { ContinuationFns } from "../src/engine.js";

function makeMessage(text: string, messageId: number): TelegramMessage {
  return {
    message_id: messageId,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeOutput(text: string, sessionId: string, background = false): string {
  return [
    ...(background ? [JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: `tool-${text}`,
        name: "Bash",
        input: { command: "npm test", run_in_background: true },
      }] },
    })] : []),
    JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId }),
  ].join("\n");
}

function readClaudeInput(options: any): string {
  const parsed = JSON.parse(String(options.stdin));
  return typeof parsed.message.content === "string"
    ? parsed.message.content
    : parsed.message.content.map((block: any) => block.text ?? "").join("\n");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("sync turn continuation", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `continuation-engine-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    delete process.env.CONTINUATION_MAX_RESUMPTIONS;
    delete process.env.CONTINUATION_MAX_LIFETIME_MS;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("delivers an intermediate Claude response, waits, and resumes the same logical run and provider session", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { live = false; }),
      now: vi.fn(() => Date.now()),
    };
    const runIds: string[] = [];
    const prompts: string[] = [];
    const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      runIds.push(options.eventContext.runId);
      prompts.push(readClaudeInput(options));
      return runCli.mock.calls.length === 1
        ? claudeOutput("Tests are running in the background.", "session-261", true)
        : claudeOutput("Tests passed; the task is complete.", "session-261");
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe",
      asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    await engine.handleMessages([makeMessage("run the tests and fix failures", 1)]);

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(new Set(runIds).size).toBe(1);
    expect(prompts[1]).toContain("background work");
    const secondArgs = runCli.mock.calls[1][1] as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs[secondArgs.indexOf("--resume") + 1]).toBe("session-261");
    const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text));
    expect(delivered).toEqual([
      "Tests are running in the background.",
      "Tests passed; the task is complete.",
    ]);
    expect(client.sendChatAction.mock.calls.length).toBeGreaterThanOrEqual(2);
    const turns = db.raw.prepare("SELECT role, content FROM conversation_turns WHERE chat_key = ? ORDER BY id").all("100") as Array<{ role: string; content: string }>;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turns[0].content).toContain("run the tests and fix failures");
    expect(turns[1].content).toContain("Tests are running");
    expect(turns[2].content).toContain("Tests passed");
  });

  it("requires both the provider hint and run-owned process evidence", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => true),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockResolvedValue(claudeOutput("Ordinary completed response.", "session-fast"));
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    await engine.handleMessages([makeMessage("normal request", 1)]);

    expect(runCli).toHaveBeenCalledOnce();
    expect(continuation.sleep).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledOnce();
  });

  it("can perform multiple bounded resumptions without adding synthetic user turns", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { live = false; }),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockImplementation(async () => {
      if (runCli.mock.calls.length === 1) return claudeOutput("Phase one running.", "session-multi", true);
      if (runCli.mock.calls.length === 2) {
        live = true;
        return claudeOutput("Phase two running.", "session-multi", true);
      }
      return claudeOutput("All phases complete.", "session-multi");
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    await engine.handleMessages([makeMessage("complete all phases", 1)]);

    expect(runCli).toHaveBeenCalledTimes(3);
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    const turns = db.raw.prepare("SELECT role FROM conversation_turns WHERE chat_key = ? ORDER BY id").all("100") as Array<{ role: string }>;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  });

  it("keeps FIFO work queued until the continued turn genuinely completes", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const wait = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { await wait.promise; live = false; }),
      now: vi.fn(() => Date.now()),
    };
    const prompts: string[] = [];
    const runCli = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      prompts.push(readClaudeInput(options));
      if (runCli.mock.calls.length === 1) return claudeOutput("Background work started.", "session-queue", true);
      if (runCli.mock.calls.length === 2) return claudeOutput("Background work finished.", "session-queue");
      return claudeOutput("Queued request finished.", "session-queue");
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude", busyMessageMode: "queue",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    const first = engine.handleMessages([makeMessage("first", 1)]);
    await waitUntil(() => (continuation.sleep as any).mock.calls.length > 0, "continuation wait");
    await engine.handleMessages([makeMessage("second", 2)]);
    expect(db.pendingMsgCount("test", "100")).toBe(1);
    expect(runCli).toHaveBeenCalledOnce();

    wait.resolve();
    await first;
    await waitUntil(() => runCli.mock.calls.length >= 3, "queued successor");

    expect(prompts[1]).toContain("background work");
    expect(prompts[2]).toContain("second");
    expect(db.pendingMsgCount("test", "100")).toBe(0);
  });

  it.each(["augment", "interrupt"] as const)("fences the old continuation before running a %s successor", async (mode) => {
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const wait = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { await wait.promise; }),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockImplementation(async () => {
      if (runCli.mock.calls.length === 1) return claudeOutput("Old task background work started.", "session-old", true);
      return claudeOutput(`Successor ${mode} completed.`, "session-new");
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude", busyMessageMode: mode,
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    const first = engine.handleMessages([makeMessage("old task", 1)]);
    await waitUntil(() => (continuation.sleep as any).mock.calls.length > 0, "continuation wait");
    const successor = engine.handleMessages([makeMessage("new instruction", 2)]);
    await nextTurn();
    wait.resolve();
    await Promise.all([first, successor]);
    await waitUntil(() => runCli.mock.calls.length >= 2, "interrupt successor");

    expect(continuation.killRunOwnedDescendants).toHaveBeenCalledOnce();
    expect(runCli).toHaveBeenCalledTimes(2);
    const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text));
    expect(delivered).toContain(`Successor ${mode} completed.`);
  });

  it("/stop kills residual run-owned work and prevents every later automatic resume or output", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const wait = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { await wait.promise; }),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockResolvedValue(claudeOutput("Background work started.", "session-stop", true));
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    const first = engine.handleMessages([makeMessage("long task", 1)]);
    await waitUntil(() => (continuation.sleep as any).mock.calls.length > 0, "continuation wait");
    const stopped = engine.handleUpdate({ update_id: 2, message: makeMessage("/stop", 2) });
    await nextTurn();
    wait.resolve();
    await Promise.all([first, stopped]);

    expect(continuation.killRunOwnedDescendants).toHaveBeenCalledOnce();
    expect(runCli).toHaveBeenCalledOnce();
    const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text));
    expect(delivered).toContain("Background work started.");
    expect(delivered.some((text) => text.includes("Execution aborted"))).toBe(true);
  });

  it("enforces the automatic-resumption bound and terminates remaining background work", async () => {
    process.env.CONTINUATION_MAX_RESUMPTIONS = "1";
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { live = false; }),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockImplementation(async () => {
      if (runCli.mock.calls.length === 1) return claudeOutput("First background phase.", "session-bound", true);
      live = true;
      return claudeOutput("Second background phase.", "session-bound", true);
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    await engine.handleMessages([makeMessage("bounded task", 1)]);

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(continuation.killRunOwnedDescendants).toHaveBeenCalledOnce();
    const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text));
    expect(delivered.at(-1)).toContain("safety limit");
  });

  it("enforces the maximum continuation lifetime before another automatic resume", async () => {
    process.env.CONTINUATION_MAX_LIFETIME_MS = "1";
    const { BridgeEngine } = await import("../src/engine.js");
    let live = true;
    let nowMs = 0;
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => { live = false; nowMs = 2; }),
      now: vi.fn(() => nowMs),
    };
    const runCli = vi.fn().mockResolvedValue(claudeOutput("Long background phase.", "session-lifetime", true));
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: false, pollIntervalMs: 1000,
    }, db, client, { runCli }, continuation);

    await engine.handleMessages([makeMessage("time-bounded task", 1)]);

    expect(runCli).toHaveBeenCalledOnce();
    expect(continuation.killRunOwnedDescendants).not.toHaveBeenCalled();
    const delivered = client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text));
    expect(delivered.at(-1)).toContain("safety limit");
  });

  it("leaves the async/streaming path explicitly unchanged", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => true),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      const raw = claudeOutput("Async background work started.", "session-async", true);
      const ctx = options.eventContext;
      options.onEvent?.(eventType.runCompleted({ ...ctx, text: raw, sessionId: null }));
      return { text: raw };
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.handleMessages([makeMessage("async task", 1)]);

    expect(runCliAsync).toHaveBeenCalledOnce();
    expect(continuation.hasLiveRunOwnedDescendants).not.toHaveBeenCalled();
    expect(continuation.sleep).not.toHaveBeenCalled();
  });
});
