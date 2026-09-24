import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";

// Unlike test/transientSameProviderFreshSessionRetry.test.ts (which mocks
// runProviderInvocation and so bypasses acpRuntime.ts's own tier-1 same-session
// retry entirely), this exercises the REAL runProviderInvocation ->
// runAcpProviderTurn -> runResolvedAcpProviderTurn chain end to end -- tier 1
// (same-session retry, inside runResolvedAcpProviderTurn) AND tier 2
// (same-provider fresh-session retry, inside engine.ts) both run for real.
// Only the two collaborators that would otherwise spawn a real child process
// and speak real ACP wire protocol are mocked (runSupervisedStdioSession,
// runAcpTurn), so the attempt-count assertion is a genuine end-to-end proof
// that tier 2's fresh-session attempt does not get its own nested tier-1
// retry (the exact gap review found: previously 4 total attempts -- 2 old
// session + 2 fresh session -- instead of the intended 3).
const runSupervisedStdioSessionMock = vi.fn(
  async (_executable: string, _args: string[], _cwd: string, _options: unknown, callback: (io: unknown) => unknown) =>
    callback({ stdin: new PassThrough(), stdout: new PassThrough(), signal: undefined }),
);
vi.mock("../src/cliSupervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cliSupervisor.js")>();
  return { ...actual, runSupervisedStdioSession: runSupervisedStdioSessionMock };
});

const runAcpTurnMock = vi.fn();
vi.mock("../src/acp/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp/client.js")>();
  return { ...actual, runAcpTurn: runAcpTurnMock };
});

function makeMessage(text: string, userId = 42, chatId = 100): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: chatId, type: "private" },
    from: { id: userId, first_name: "Test" },
    text,
  };
}

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

describe("end-to-end transient retry ladder: exactly 3 total attempts before fallback", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `transient-ladder-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
    process.env.CODEX_ACP_COMMAND = process.execPath;
    runSupervisedStdioSessionMock.mockClear();
    runAcpTurnMock.mockReset();
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
    delete process.env.CODEX_ACP_COMMAND;
  });

  it("a persistent transient failure produces exactly 3 real attempts (tier 1's 2 same-session + tier 2's 1 fresh-session), then falls back", async () => {
    runAcpTurnMock.mockRejectedValue(new Error("Selected model is at capacity. Please try a different model."));

    const fallbackRequests: string[] = [];
    const client = makeMockClient();
    const { BridgeEngine } = await import("../src/engine.js");
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        hooks: {
          onProviderFallbackRequested: async (_chatKey: string, reason: string) => { fallbackRequests.push(reason); },
        },
      },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    // Tier 1 (same session, inside runResolvedAcpProviderTurn): 2 attempts.
    // Tier 2 (same provider, fresh session, inside engine.ts): 1 attempt,
    // with tier 1 suppressed for it. 2 + 1 = 3 total, not 4.
    expect(runAcpTurnMock).toHaveBeenCalledTimes(3);
    expect(fallbackRequests).toEqual(["provider_transport_failure"]);
  }, 15_000);
});
