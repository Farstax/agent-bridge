import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import type { TelegramMessage } from "../src/types.js";
import { withPassiveSurroundingContext } from "../src/workspaceContext.js";

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10_000),
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
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

describe("provider-native context lifecycle", () => {
  it("injects managed workspace context only on fresh sessions while preserving passive per-turn evidence", async () => {
    const database = openDb(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "workspace-context-lifecycle-"));
    const file = join(dir, "workspace-context.md");
    const workspaceMarker = "managed-workspace-marker-706";
    writeFileSync(file, `${workspaceMarker}\n`);
    const previousWorkspaceFile = process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
    process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE = file;

    try {
      const capturedPrompts: string[] = [];
      const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
        capturedPrompts.push(args[args.length - 1]);
        return JSON.stringify({ type: "result", result: "ok", session_id: "native-session-706" });
      });
      const engine = new BridgeEngine({
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      }, database, makeMockClient(), { runCli });

      await withPassiveSurroundingContext([
        { actorId: "guest", actorLabel: "Guest", messageId: "prior-1", text: "fresh passive evidence" },
      ], () => engine.handleMessages([makeMessage("first request")]));

      await withPassiveSurroundingContext([
        { actorId: "guest", actorLabel: "Guest", messageId: "prior-2", text: "resumed passive evidence" },
      ], () => engine.handleMessages([makeMessage("second request")]));

      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[0]).toContain(workspaceMarker);
      expect(capturedPrompts[0]).toContain("fresh passive evidence");
      expect(capturedPrompts[1]).not.toContain(workspaceMarker);
      expect(capturedPrompts[1]).toContain("[Passive Discord surrounding context]");
      expect(capturedPrompts[1]).toContain("resumed passive evidence");
      expect(capturedPrompts[1]).toContain("[Current authenticated request]\nsecond request");
      expect(capturedPrompts[1]).not.toContain("first request");
    } finally {
      if (previousWorkspaceFile === undefined) delete process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
      else process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE = previousWorkspaceFile;
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
