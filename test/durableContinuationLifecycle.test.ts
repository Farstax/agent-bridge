import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ContinuationFns } from "../src/engine.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";
import type { TelegramMessage } from "../src/types.js";

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
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("durable async continuation lifecycle", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `durable-continuation-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath, { serviceId: "test-service", runId: "test-process", lockLeaseMs: 100 });
  });

  afterEach(() => {
    delete process.env.CONTINUATION_MAX_RESUMPTIONS;
    delete process.env.CONTINUATION_MAX_LIFETIME_MS;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("persists an async wait before waking and resumes through the same durable run and provider session", async () => {
    let processState: "live" | "absent" = "live";
    const gate = deferred();
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => processState === "live"),
      getRunOwnedProcessState: vi.fn(() => processState),
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => { await gate.promise; processState = "absent"; }),
      now: vi.fn(() => Date.now()),
    };
    const runIds: string[] = [];
    const prompts: string[] = [];
    const runCliAsync = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      runIds.push(options.eventContext.runId);
      prompts.push(readClaudeInput(options));
      return {
        text: runCliAsync.mock.calls.length === 1
          ? claudeOutput("Background work is running.", "session-async-261", true)
          : claudeOutput("Background work finished.", "session-async-261"),
      };
    });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);
    const repo = new ContinuationRepository(db.raw);

    const execution = engine.handleMessages([makeMessage("run the tests", 1)]);
    await waitUntil(() => runIds.length === 1 && repo.listActive("test", "claude").length === 1, "durable waiting checkpoint");

    const waiting = repo.listActive("test", "claude")[0];
    expect(waiting.state).toBe("waiting");
    expect(waiting.sessionId).toBe("session-async-261");
    expect(waiting.executionMode).toBe("async");
    expect(waiting.runId).toBe(runIds[0]);

    gate.resolve();
    await execution;

    expect(runCliAsync).toHaveBeenCalledTimes(2);
    expect(new Set(runIds).size).toBe(1);
    expect(prompts[1]).toContain("background work");
    const secondArgs = runCliAsync.mock.calls[1][1] as string[];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs[secondArgs.indexOf("--resume") + 1]).toBe("session-async-261");
    expect(repo.get(runIds[0])?.state).toBe("completed");
    expect(client.sendMessage.mock.calls.map((call: any[]) => String(call[0].text))).toEqual([
      "Background work is running.",
      "Background work finished.",
    ]);
  });

  it("recovers a persisted waiting turn once, preserving the durable run id", async () => {
    const durableRunId = "durable-run-261";
    db.insertRun(durableRunId, "100", "claude");
    const repo = new ContinuationRepository(db.raw);
    const startedAt = new Date(Date.now() - 1000).toISOString();
    repo.saveWaiting({
      runId: durableRunId,
      surface: "test",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "session-restart-261",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: durableRunId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => false),
      getRunOwnedProcessState: vi.fn(() => "absent"),
      killRunOwnedDescendants: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("Recovered work complete.", "session-restart-261") });
    const client = makeMockClient();
    const engine = new BridgeEngine({
      surfaceIdentity: "test", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync }, continuation);

    await engine.recoverContinuations();
    await waitUntil(() => repo.get(durableRunId)?.state === "completed", "recovered continuation completion");
    await engine.recoverContinuations();
    await nextTurn();

    expect(runCliAsync).toHaveBeenCalledOnce();
    const options = runCliAsync.mock.calls[0][3] as any;
    expect(options.eventContext.runId).toBe(durableRunId);
    expect(repo.get(durableRunId)?.state).toBe("completed");
    expect(db.getRun(durableRunId)?.status).toBe("done");
  });
});
