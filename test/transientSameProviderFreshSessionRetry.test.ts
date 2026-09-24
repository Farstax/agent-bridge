import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import type { TelegramMessage } from "../src/types.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";

// runProviderInvocation is the provider-neutral ACP transport entry point used
// by engine.ts. Mocking it here drives the engine's real tier-2 same-provider
// fresh-session retry path deterministically, without spawning a real ACP
// stdio child. This bypasses acpRuntime.ts's own tier-1 same-session retry
// (covered separately in test/transientRetrySameSession.test.ts), so each
// mocked rejection here represents what engine.ts sees once tier 1 has
// already been exhausted.
const runProviderInvocationMock = vi.fn();
vi.mock("../src/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli.js")>();
  return { ...actual, runProviderInvocation: runProviderInvocationMock };
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

describe("tier 2: same-provider fresh-session retry for a transient failure", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `transient-tier2-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    runProviderInvocationMock.mockReset();
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
    delete process.env.CODEX_ACP_COMMAND;
  });

  it("silently retries once on a fresh session and delivers the recovered answer with no fallback hook fired", async () => {
    const chatKey = "100";
    persistProviderSession(db, chatKey, "codex", "stale-session-id");
    runProviderInvocationMock.mockRejectedValueOnce(
      new Error("Selected model is at capacity. Please try a different model."),
    );
    runProviderInvocationMock.mockResolvedValueOnce({
      text: "recovered on fresh session",
      sessionId: "fresh-session-id",
      stopReason: "end_turn",
    });

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

    expect(runProviderInvocationMock).toHaveBeenCalledTimes(2);
    // The retry must use a fresh session, not resume the one that just failed.
    expect(runProviderInvocationMock.mock.calls[1][4].sessionId).toBeNull();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage.mock.calls[0][0].text).toContain("recovered on fresh session");
    // Silent: no cross-provider fallback was requested, no "Switching to..." style notice.
    expect(fallbackRequests).toEqual([]);
    expect(lookupProviderSession(db, chatKey, "codex")).toBe("fresh-session-id");
  });

  it("falls through to the existing cross-provider fallback path when the fresh-session retry also fails", async () => {
    const chatKey = "100";
    runProviderInvocationMock.mockRejectedValue(
      new Error("Selected model is at capacity. Please try a different model."),
    );

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

    // Exactly one primary attempt plus one tier-2 retry -- no further looping.
    expect(runProviderInvocationMock).toHaveBeenCalledTimes(2);
    expect(fallbackRequests).toEqual(["provider_transport_failure"]);
    expect(lookupProviderSession(db, chatKey, "codex")).toBeNull();
  });

  it("does not attempt a tier-2 retry for a non-transient (capacity_exhausted) failure", async () => {
    const chatKey = "100";
    runProviderInvocationMock.mockRejectedValue(new Error("usage limit reached"));

    const client = makeMockClient();
    const { BridgeEngine } = await import("../src/engine.js");
    const engine = new BridgeEngine(
      { surfaceIdentity: "test", kind: "codex", botConfig: { command: "codex", modelPreference: [] }, allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1000 },
      db, client, {},
    );

    await engine.handleMessages([makeMessage("hello")]);

    expect(runProviderInvocationMock).toHaveBeenCalledTimes(1);
    void chatKey;
  });
});
