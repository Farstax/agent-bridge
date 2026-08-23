import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import type { TelegramMessage } from "../src/types.js";

const HISTORY_MARKER = "issue-538-older-turn";
const HANDOFF_CONCEPTS = [
  "user goal",
  "what was done / evidence",
  "current state",
  "pending / next steps",
  "key context / constraints",
];

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: Math.floor(Math.random() * 10000),
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

function makeEngine(db: ReturnType<typeof openDb>, dbPath: string, runCli: ReturnType<typeof vi.fn>) {
  return new BridgeEngine(
    {
      surfaceIdentity: "test",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      asyncEnabled: false,
      pollIntervalMs: 1000,
      fullConfig: { dbPath } as any,
    },
    db,
    {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    } as any,
    { runCli },
  );
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
    db.addConvTurn("100", "user", HISTORY_MARKER);
    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return JSON.stringify({ type: "result", result: "ok", session_id: "issue-538-session" });
    });

    await makeEngine(db, dbPath, runCli).handleMessages([makeMessage("continue the work")]);

    expect(capturedPrompt).toContain("[Agent Bridge handoff]");
    expect(capturedPrompt).toContain(HISTORY_MARKER);
    for (const concept of HANDOFF_CONCEPTS) expect(capturedPrompt).toContain(concept);
    expect(capturedPrompt).toContain("exact recent turns");
    expect(capturedPrompt).toContain('"$AGENT_BRIDGE_CONTEXT_COMMAND" --search "<terms>"');
  });

  it("keeps first-ever fresh-session guidance conditional when no prior turns exist", async () => {
    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return JSON.stringify({ type: "result", result: "ok", session_id: "issue-538-new-session" });
    });

    await makeEngine(db, dbPath, runCli).handleMessages([makeMessage("start new work")]);

    expect(capturedPrompt).toContain("[Agent Bridge handoff]");
    expect(capturedPrompt).toContain("When prior conversation context is supplied");
    expect(capturedPrompt).not.toContain("bounded exact recent turns below");
  });

  it("does not repeat the handoff guidance on an ordinary resumed native turn", async () => {
    db.addConvTurn("100", "user", HISTORY_MARKER);
    db.setSession("100", "claude", "existing-session");
    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return "ok";
    });

    await makeEngine(db, dbPath, runCli).handleMessages([makeMessage("ordinary continuation")]);

    expect(capturedPrompt).toContain("ordinary continuation");
    expect(capturedPrompt).not.toContain("[Agent Bridge handoff]");
    expect(capturedPrompt).not.toContain(HISTORY_MARKER);
    for (const concept of HANDOFF_CONCEPTS) expect(capturedPrompt).not.toContain(concept);
  });
});
