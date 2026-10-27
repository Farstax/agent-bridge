import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { persistProviderSession } from "../src/providers/sessionRuntime.js";
import { BridgeEngine } from "../src/engine.js";
import {
  buildTelegramRunContinuationTurn,
  linkRunContinuationRun,
  listRunContinuations,
  requestRunContinuation,
  scanRunContinuations,
} from "../src/runContinuation.js";
import { readRunOutcome, requestAgentBridgeOutcome } from "../src/runOutcome.js";

const paths: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of paths.splice(0)) rmSync(p, { force: true }); });

describe("engine integration of the continuation chain limit (#1084)", () => {
  it("links the successor Run before the provider runs, refuses the 21st continuation there and tells the owner", async () => {
    const path = join(tmpdir(), `chain-engine-${Date.now()}-${Math.random()}.sqlite`); paths.push(path);
    const db = openDb(path, { serviceId: "chain-engine", runId: "process" });
    const chatKey = "555";
    const scope = { surfaceIdentity: "telegram:interactive", chatKey };
    // Build 19 completed hops, then a pending 20th continuation (depth 20).
    let previous: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const runId = `hop-${i}`;
      db.insertRun(runId, scope, "claude");
      if (previous) linkRunContinuationRun(db, previous, runId);
      requestRunContinuation(db, { originRunId: runId, ...scope, provider: "claude", reason: "CI pending", afterSeconds: 5 }, 1_000);
      previous = runId;
    }
    const lastRun = db.getRun("hop-19");
    persistProviderSession(db, scope, "claude", "session-hop-19", "hop-19");
    expect(db.updateRunCompleted("hop-19", "done", "session-hop-19")).toBe(true);
    for (let i = 0; i < 19; i += 1) {
      persistProviderSession(db, scope, "claude", `session-hop-${i}`, `hop-${i}`);
      db.updateRunCompleted(`hop-${i}`, "done", `session-hop-${i}`);
    }
    persistProviderSession(db, scope, "claude", "session-hop-19", "hop-19");
    void lastRun;

    const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    let observed: { successor?: string; threw?: string; outcome?: string | null } = {};
    const provider = vi.fn(async (...args: any[]) => {
      const env = args.map((a) => a?.contextEnv).find(Boolean) as Record<string, string> | undefined;
      const runId = env?.AGENT_BRIDGE_RUN_ID as string;
      // Providers announce the Run first; the outcome helper cannot act before this row exists.
      const opts = args.find((a) => typeof a?.onEvent === "function");
      opts?.onEvent({
        type: "run.started", version: 1, id: "evt-start", runId, timestamp: new Date().toISOString(),
        bot: "claude", chatId: chatKey, chatKey, command: "claude", cwd: "/tmp", model: null,
      });
      observed.successor = listRunContinuations(db).find((c) => c.originRunId === "hop-19")?.successorRunId;
      expect(observed.successor).toBe(runId);
      try {
        requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "still waiting"], env);
      } catch (error) {
        observed.threw = (error as Error).message;
      }
      observed.outcome = readRunOutcome(db, runId)?.status ?? null;
      return { text: "Stopped; waiting for the owner.", sessionId: "session-hop-19", stopReason: "end_turn" };
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
      fullConfig: { dbPath: path } as any,
    }, db, {
      getSurfaceCapabilities: () => ({ maxMessageLength: 4096, editMessages: true, deleteMessages: true, previewStreaming: true, threads: true, attachments: true, typing: true, polling: true, remoteFileDownload: true, richMessages: true, passiveSurroundingContext: false, formatting: "telegram-html" }),
      sendMessage,
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue({ ok: true }),
    } as any, { runProviderInvocation: provider } as any);

    await scanRunContinuations(db, "telegram:interactive", async (c) => engine.handleInteractiveTurn(buildTelegramRunContinuationTurn(c, "42")), 6_000);

    expect(provider).toHaveBeenCalled();
    expect(observed.threw).toMatch(/continuation limit/i);
    expect(observed.outcome).toBe("blocked");
    expect(listRunContinuations(db)).toHaveLength(20);
    const texts = sendMessage.mock.calls.map((call) => JSON.stringify(call));
    expect(texts.some((t) => /Automatic continuation stopped/.test(t))).toBe(true);
    db.close();
  });
});
