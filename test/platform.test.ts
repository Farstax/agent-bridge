import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";

describe("MessagingPlatform abstraction — Phase 1", () => {
  it("BridgeEngine constructor accepts a plain MessagingPlatform stub (not a TelegramClient)", async () => {
    // This test fails before Phase 1 because platform.ts does not exist.
    // After Phase 1, BridgeEngine accepts MessagingPlatform so any conforming object works.
    await import("../src/platform.js"); // fails if file missing

    const { BridgeEngine } = await import("../src/engine.js");

    const stub = {
      getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
      editMessageText: vi.fn().mockResolvedValue({ ok: true }),
      sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
      answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
      setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendPhoto: vi.fn().mockResolvedValue(undefined),
      getFilePath: vi.fn().mockResolvedValue("remote/path"),
      downloadFile: vi.fn().mockResolvedValue(undefined),
    };

    const dbPath = join(tmpdir(), `platform-test-${Date.now()}.sqlite`);
    const db = openDb(dbPath);
    try {
      const engine = new BridgeEngine(
        {
          surfaceIdentity: "test",
          kind: "claude",
          botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          pollIntervalMs: 1000,
        },
        db,
        stub as any,
      );
      expect(engine).toBeDefined();
      expect(engine.client).toBe(stub);
    } finally {
      db.close();
      try { rmSync(dbPath); } catch {}
    }
  });
});
