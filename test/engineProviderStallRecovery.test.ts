import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderStallError } from "../src/cli.js";
import type { TelegramMessage } from "../src/types.js";

function message(id: number, text: string): TelegramMessage {
  return {
    message_id: id,
    chat: { id: 858, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function client() {
  return {
    capabilities: {
      maxMessageLength: 4096, editMessages: true, deleteMessages: true,
      previewStreaming: true, threads: true, attachments: true, typing: true,
      polling: true, remoteFileDownload: true, richMessages: true,
      passiveSurroundingContext: false, formatting: "telegram-html",
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

describe("same-run provider stall recovery", () => {
  it("retries under the same run and session with a recovery continuation", async () => {
    const db = openDb(":memory:");
    const calls: Array<{ request: any; identities: any }> = [];
    let invocation = 0;
    const runProviderInvocation = vi.fn(async (
      _kind: string,
      _invocation: any,
      _cwd: string,
      _options: any,
      request: any,
      identities: any,
    ) => {
      invocation += 1;
      calls.push({ request, identities });
      if (invocation === 1) return { text: "seed", sessionId: "session-858", stopReason: "end_turn" };
      if (invocation === 2) throw new ProviderStallError("stalled");
      return { text: "recovered", sessionId: "session-858", stopReason: "end_turn" };
    });

    try {
      const engine = new BridgeEngine({
        surfaceIdentity: "test",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      }, db, client(), { runProviderInvocation } as any);

      await engine.handleMessages([message(1, "seed request")]);
      await engine.handleMessages([message(2, "finish the task")]);

      expect(calls).toHaveLength(3);
      expect(calls[1].request.sessionId).toBe("session-858");
      expect(calls[2].request.sessionId).toBe("session-858");
      expect(calls[2].request.prompt).toContain("[Agent Bridge automatic recovery]");
      expect(calls[2].request.prompt).toContain("finish the task");
      expect(calls[2].identities.runId).toBe(calls[1].identities.runId);
      expect(calls[2].identities.runId).not.toBe(calls[0].identities.runId);
    } finally {
      db.close();
    }
  });

  it("bounds automatic stall retries at two", async () => {
    const db = openDb(":memory:");
    let attempts = 0;
    const runProviderInvocation = vi.fn(async () => {
      attempts += 1;
      throw new ProviderStallError("still stalled");
    });

    try {
      const engine = new BridgeEngine({
        surfaceIdentity: "test",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      }, db, client(), { runProviderInvocation } as any);

      await engine.handleMessages([message(3, "do work")]);
      expect(attempts).toBe(3);
    } finally {
      db.close();
    }
  });
});
