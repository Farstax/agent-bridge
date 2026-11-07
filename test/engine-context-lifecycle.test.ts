import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { acpEngineExec } from "./support/acpEngineExec.js";
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
        capturedPrompts.push(args[1]);
        return [JSON.stringify({ type: "text", data: "ok" }), JSON.stringify({ type: "end", sessionId: "native-session-706", stopReason: "end_turn" })].join("\n") + "\n";
      });
      const engine = new BridgeEngine({
        surfaceIdentity: "test",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
      }, database, makeMockClient(), acpEngineExec(runCli));

      await withPassiveSurroundingContext([
        { actorId: "guest", actorLabel: "Guest", messageId: "prior-1", text: "fresh passive evidence" },
      ], () => engine.handleMessages([makeMessage("first request")]));

      await withPassiveSurroundingContext([
        { actorId: "guest", actorLabel: "Guest", messageId: "prior-2", text: "resumed passive evidence" },
      ], () => engine.handleMessages([makeMessage("second request")]));

      expect(capturedPrompts).toHaveLength(2);
      expect(capturedPrompts[0]).toContain(workspaceMarker);
      expect(capturedPrompts[0]).toContain("fresh passive evidence");
      expect(capturedPrompts[0]).toContain("Agent Bridge execution contract:");
      expect(capturedPrompts[1]).not.toContain(workspaceMarker);
      expect(capturedPrompts[1]).toContain("[Passive Discord surrounding context]");
      expect(capturedPrompts[1]).toContain("resumed passive evidence");
      expect(capturedPrompts[1]).toContain("[Current authenticated request]\nsecond request");
      // Issue #903: a resumed provider turn still receives the delegation
      // contract even though fresh-only Soul/workspace/handoff context is not repeated.
      expect(capturedPrompts[1]).toContain("Agent Bridge execution contract:");
      expect(capturedPrompts[1]).not.toContain("first request");
    } finally {
      if (previousWorkspaceFile === undefined) delete process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE;
      else process.env.AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE = previousWorkspaceFile;
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("briefs fresh Desk sessions about supported presentation and copy blocks, not resumed or non-Desk sessions", async () => {
    async function capture(surfaceIdentity: string): Promise<string[]> {
      const db = openDb(":memory:");
      try {
        const prompts: string[] = [];
        const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
          prompts.push(args[1]);
          return [JSON.stringify({ type: "text", data: "ok" }),
            JSON.stringify({ type: "end", sessionId: "rendering-provider-session", stopReason: "end_turn" })].join("\n") + "\n";
        });
        const engine = new BridgeEngine({
          surfaceIdentity, kind: "cursor",
          botConfig: { command: "cursor", modelPreference: [] },
          allowedUserIds: new Set(["42"]), executionMode: "safe",
          pollIntervalMs: 1000, workingDir: process.cwd(),
        }, db, makeMockClient(), acpEngineExec(runCli));

        await engine.handleMessages([makeMessage("first request")]);
        await engine.handleMessages([makeMessage("second request")]);
        return prompts;
      } finally {
        db.close();
      }
    }

    const desk = await capture("acp:outward");
    const telegram = await capture("telegram:test");
    expect(desk).toHaveLength(2);
    expect(desk[0]).toContain("[Desk presentation capabilities]");
    expect(desk[0]).toContain("fenced code blocks");
    expect(desk[0]).toContain("copy/paste");
    expect(desk[0]).toContain("mermaid");
    expect(desk[0]).toContain("User request:");
    expect(desk[1]).not.toContain("[Desk presentation capabilities]");
    expect(telegram).toHaveLength(2);
    expect(telegram.every((prompt) => !prompt.includes("[Desk presentation capabilities]"))).toBe(true);
  });

  it("briefs an isolated Desk side question without changing its tool-free contract", async () => {
    const db = openDb(":memory:");
    try {
      const requests: Array<{ prompt: string; toolMode?: string; sessionId: string | null }> = [];
      const engine = new BridgeEngine({
        surfaceIdentity: "acp:outward", kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]), executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, makeMockClient(), {
        runProviderInvocation: vi.fn(async (_kind, _invocation, _cwd, _options, request) => {
          requests.push({ prompt: request.prompt, toolMode: request.toolMode, sessionId: request.sessionId });
          return { text: "answer", sessionId: null, stopReason: "end_turn" };
        }),
      });
      await expect(engine.executeSurfaceNeutralBtw("a reusable prompt", "btw-example")).resolves.toBe("answer");
      expect(requests).toHaveLength(1);
      expect(requests[0].prompt).toContain("[Desk presentation capabilities]");
      expect(requests[0].prompt).toContain("a reusable prompt");
      expect(requests[0].toolMode).toBe("none");
      expect(requests[0].sessionId).toBeNull();
    } finally {
      db.close();
    }
  });

});
