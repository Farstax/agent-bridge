import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("BridgeEngine provider-attempt contract", () => {
  it("executes an ordinary provider attempt through the canonical native runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-provider-attempt-"));
    const db = openDb(join(root, "bridge.sqlite"));
    const runCli = vi.fn().mockResolvedValue("legacy response");
    const runCliAsync = vi.fn().mockResolvedValue({ text: "provider response" });
    const engine = new BridgeEngine({
      kind: "claude", surfaceIdentity: "test",
      botConfig: { command: "claude", modelPreference: ["claude-primary"] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", pollIntervalMs: 1_000,
    }, db, client(), { runCli, runCliAsync });
    const handle = db.acquireLock("test", "100");
    try {
      expect(handle).not.toBeNull();
      const result = await engine.executePromptAsync("hello", null, 100, {}, () => {}, [], undefined, null, null, "100", handle!);
      expect(result.text).toBe("provider response");
      expect(result.sessionId).toBeNull();
      expect(runCliAsync).toHaveBeenCalledOnce();
      expect(runCli).not.toHaveBeenCalled();
    } finally {
      if (handle && db.ownsLock(handle)) db.unlock(handle);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
