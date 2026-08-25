import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import type { TelegramMessage } from "../src/types.js";

function makeMessage(text: string): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "Test" },
    text,
  };
}

describe("clean-droplet acceptance", () => {
  it("starts the first Codex invocation with codex exec after database startup", async () => {
    const db = openDb(":memory:");
    let calls = 0;
    const runCli = async (command: string, args: string[]) => {
      calls += 1;
      expect(command).toBe("codex");
      expect(args[0]).toBe("exec");
      expect(args).not.toContain("resume");
      return JSON.stringify({ result: "ok", session_id: "fresh-session" });
    };
    const engine = new BridgeEngine(
      {
        surfaceIdentity: "clean-appliance",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "trusted",
        pollIntervalMs: 1000,
      },
      db,
      { sendMessage: async () => ({ ok: true, result: { message_id: 2 } }) } as any,
      { runCli: runCli as any },
    );
    await engine.handleMessages([makeMessage("first request on a new appliance")]);
    expect(calls).toBe(1);
    db.raw.close();
  });
});
