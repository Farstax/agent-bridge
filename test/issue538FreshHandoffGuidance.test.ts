import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import type { BridgeConfig, TelegramMessage } from "../src/types.js";

const HISTORY_MARKER = "issue-538-older-turn";
const HANDOFF_GUIDANCE = "Continue naturally. Recover the user goal, what was done / evidence, current state, pending / next steps, and key context / constraints from the bounded exact recent turns below. Search older conversation history when needed.";

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
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
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function makeFullConfig(dbPath: string): BridgeConfig {
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath,
    bots: {
      codex: { token: undefined, command: "codex", modelPreference: [] },
      claude: { token: undefined, command: "claude", modelPreference: [] },
      antigravity: { token: undefined, command: "agy", modelPreference: [] },
    },
  };
}

describe("Issue #538 fresh-session handoff guidance", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `issue-538-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  it("orients a fresh provider from exact retained turns and preserves scoped older-history search", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    db.addConvTurn("100", "user", HISTORY_MARKER);

    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return JSON.stringify({ type: "result", result: "ok", session_id: "issue-538-session" });
    });
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1000,
        fullConfig: makeFullConfig(dbPath),
      },
      db,
      makeMockClient(),
      { runCli },
    );

    await engine.handleMessages([makeMessage("continue the work")]);

    expect(capturedPrompt).toContain(HISTORY_MARKER);
    expect(capturedPrompt).toContain(HANDOFF_GUIDANCE);
    expect(capturedPrompt).toContain('"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"');
  });

  it("does not repeat the handoff guidance on an ordinary resumed native turn", async () => {
    const { BridgeEngine } = await import("../src/engine.js");
    db.addConvTurn("100", "user", HISTORY_MARKER);
    db.setSession("100", "claude", "existing-session");

    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return "ok";
    });
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "test",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        asyncEnabled: false,
        pollIntervalMs: 1000,
        fullConfig: makeFullConfig(dbPath),
      },
      db,
      makeMockClient(),
      { runCli },
    );

    await engine.handleMessages([makeMessage("ordinary continuation")]);

    expect(capturedPrompt).toContain("ordinary continuation");
    expect(capturedPrompt).not.toContain(HISTORY_MARKER);
    expect(capturedPrompt).not.toContain(HANDOFF_GUIDANCE);
  });
});
