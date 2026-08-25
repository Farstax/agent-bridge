import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { buildCliInvocation } from "../src/cli.js";
import type { TelegramMessage } from "../src/types.js";

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: 451,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Owner" },
    text,
  };
}

function makeClient() {
  return {
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

describe("unknown authenticated slash commands", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `unknown-slash-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("passes an unknown slash command to the active native CLI as the original prompt", async () => {
    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      capturedPrompt = args.at(-1) ?? "";
      return "Company status returned by native skill.";
    });
    const client = makeClient();
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      },
      db,
      client,
      { runCli },
    );

    await engine.handleMessages([makeMessage("/company status")]);

    expect(runCli).toHaveBeenCalledTimes(1);
    expect(capturedPrompt).toContain("/company status");
  });

  it.each([
    { bot: "claude", command: "claude", sessionId: "sess-claude" },
    { bot: "codex", command: "codex", sessionId: "sess-codex" },
    { bot: "antigravity", command: "agy", sessionId: "sess-agy" },
  ])("keeps resumed unclaimed slash requests out of native $bot slash parsing", ({ bot, command, sessionId }) => {
    for (const prompt of ["/company", "/company status", "/company approve", "/company stop"]) {
      const invocation = buildCliInvocation({
        bot,
        prompt,
        sessionId,
        command,
        includeResponseContract: false,
      });
      const providerPrompt = invocation.args.at(-1) ?? invocation.stdin ?? "";

      expect(providerPrompt).toContain(prompt);
      expect(providerPrompt.startsWith("/")).toBe(false);
    }
  });

  it.each([
    { bot: "claude", command: "claude", sessionId: "sess-claude" },
    { bot: "codex", command: "codex", sessionId: "sess-codex" },
  ])("leaves ordinary resumed $bot prompts unchanged", ({ bot, command, sessionId }) => {
    const invocation = buildCliInvocation({
      bot,
      prompt: "status please",
      sessionId,
      command,
      includeResponseContract: false,
    });

    expect(invocation.args.at(-1)).toBe("status please");
  });

  it("keeps a known Bridge command local instead of sending it to the native CLI", async () => {
    const runCli = vi.fn().mockResolvedValue("must not run");
    const client = makeClient();
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      },
      db,
      client,
      { runCli },
    );

    await engine.handleMessages([makeMessage("/reset")]);

    expect(runCli).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("session reset"),
    }));
  });
});
