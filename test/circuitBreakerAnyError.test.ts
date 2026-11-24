import { attachProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";

// runProviderInvocation is the provider-neutral ACP transport entry point used
// by engine.ts. Mocking it here drives the engine's real circuit-breaker path
// deterministically, without spawning a real ACP stdio child.
const runProviderInvocationMock = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli.js")>();
  return { ...actual, runProviderInvocation: runProviderInvocationMock };
});

function makeMockClient() {
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

describe("circuit breaker reacts to any consecutive provider error", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `circuit-breaker-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    runProviderInvocationMock.mockReset();
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
    delete process.env.CODEX_ACP_COMMAND;
  });

  it("clears the persisted session after two consecutive failures that are not timeouts or killed-by-signal", async () => {
    const chatKey = "100";
    persistProviderSession(db, { surfaceIdentity: "test", chatKey: chatKey }, "codex", "existing-session-id");

    const { BridgeEngine } = await import("../src/engine.js");
    const client = makeMockClient();
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    // Exercise the attempt owner directly: the interactive router now performs
    // immediate inspection-first recovery for unknown provider failures, which
    // independently clears the binding and would mask the breaker threshold.
    const laneHandle = db.acquireLock("test", chatKey);
    if (!laneHandle) throw new Error("test lane unavailable");
    let attempt = 0;
    const run = () => engine.executeSurfaceNeutralTurn({
      prompt: "task", sessionId: "existing-session-id", chatId: chatKey, chatKey,
      laneHandle, runId: `breaker-${++attempt}`,
      eventContext: { runId: `breaker-${attempt}`, bot: "codex", chatId: chatKey, chatKey },
      collect: () => {},
    });
    try {
      runProviderInvocationMock.mockRejectedValue(new Error("ACP connection closed"));
      for (let i = 0; i < 2; i++) await expect(run()).rejects.toThrow("ACP connection closed");
      expect(lookupProviderSession(db, { surfaceIdentity: "test", chatKey }, "codex")).toBe("existing-session-id");

      runProviderInvocationMock.mockRejectedValue(attachProviderFailureEvidence(new Error("ACP connection closed"), { promptSubmitted: true }));
      await expect(run()).rejects.toThrow("ACP connection closed");
      expect(lookupProviderSession(db, { surfaceIdentity: "test", chatKey }, "codex")).toBe("existing-session-id");

      await expect(run()).rejects.toThrow("ACP connection closed");
      expect(lookupProviderSession(db, { surfaceIdentity: "test", chatKey }, "codex")).toBeNull();
    } finally {
      db.unlock(laneHandle);
    }
  });
});
