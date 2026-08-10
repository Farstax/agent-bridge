import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ContinuationFns } from "../src/engine.js";

function claudeOutput(text: string, sessionId: string, background = false): string {
  return [
    ...(background ? [JSON.stringify({
      type: "assistant",
      message: { content: [{
        type: "tool_use",
        id: "tool-bg",
        name: "Bash",
        input: { command: "true", run_in_background: true },
      }] },
    })] : []),
    JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId }),
  ].join("\n");
}

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("continuation process evidence timing", () => {
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `continuation-exit-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("resumes when run-owned work was alive at direct CLI exit even if it finishes during post-processing", async () => {
    let live = true;
    const continuation: ContinuationFns = {
      hasLiveRunOwnedDescendants: vi.fn(() => live),
      killRunOwnedDescendants: vi.fn(async () => { live = false; }),
      sleep: vi.fn(async () => {}),
      now: vi.fn(() => Date.now()),
    };
    const runCli = vi.fn().mockImplementation(async () => runCli.mock.calls.length === 1
      ? claudeOutput("The background command was started.", "session-exit", true)
      : claudeOutput("I inspected the finished command and completed the task.", "session-exit"));
    const mockClient = client();
    const engine = new BridgeEngine({
      surfaceIdentity: "test",
      kind: "claude",
      botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      asyncEnabled: false,
      pollIntervalMs: 1000,
      hooks: {
        onAfterExecute: async () => { live = false; },
      },
    }, db, mockClient, { runCli }, continuation);

    await engine.handleMessages([{
      message_id: 1,
      chat: { id: 100, type: "private" },
      from: { id: 42, first_name: "Test" },
      text: "run the background command and finish the task",
    }]);

    expect(runCli).toHaveBeenCalledTimes(2);
    expect(continuation.sleep).not.toHaveBeenCalled();
    expect(mockClient.sendMessage.mock.calls.map((call: any[]) => call[0].text)).toEqual([
      "The background command was started.",
      "I inspected the finished command and completed the task.",
    ]);
  });
});
