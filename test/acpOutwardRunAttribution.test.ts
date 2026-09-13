import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import { BridgeOutwardAcpPromptExecutor } from "../src/acpServer/execution.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

describe("outward ACP Run provider attribution", () => {
  it("attributes a successful fallback Run to the provider that completed it", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-attribution-success-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-session-success",
        conversationId: "acp:attribution-success",
        cwd: root,
      });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex", "claude"] as const,
        runId: () => "run-attribution-success",
        createEngine: (_session, provider) => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.collect(eventType.runStarted({
              runId: input.runId,
              bot: provider,
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              command: `${provider}-acp`,
              cwd: root,
              model: null,
            }));
            if (provider === "codex") throw new Error("usage limit");
            input.collect(eventType.runCompleted({
              runId: input.runId,
              bot: provider,
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              text: "completed by claude",
              sessionId: "claude-session",
            }));
            return {
              text: "completed by claude",
              sessionId: "claude-session",
              stopReason: "end_turn",
            };
          },
        }),
      });

      const response = await executor.execute({
        session,
        prompt: "fallback once",
        signal: new AbortController().signal,
        onUpdate: () => {},
      });

      expect(response.stopReason).toBe("end_turn");
      expect(db.getRun("run-attribution-success")).toMatchObject({
        bot: "claude",
        status: "done",
        session_id: "claude-session",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attributes a failed fallback Run to the provider whose attempt failed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-attribution-failure-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-session-failure",
        conversationId: "acp:attribution-failure",
        cwd: root,
      });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex", "claude"] as const,
        runId: () => "run-attribution-failure",
        createEngine: (_session, provider) => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.collect(eventType.runStarted({
              runId: input.runId,
              bot: provider,
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              command: `${provider}-acp`,
              cwd: root,
              model: null,
            }));
            if (provider === "codex") throw new Error("usage limit");
            input.collect(eventType.runFailed({
              runId: input.runId,
              bot: provider,
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              error: "fatal provider failure",
              category: "unknown",
            }));
            throw new Error("fatal provider failure");
          },
        }),
      });

      await expect(executor.execute({
        session,
        prompt: "fallback then fail",
        signal: new AbortController().signal,
        onUpdate: () => {},
      })).rejects.toThrow(/outward ACP prompt execution failed/);

      expect(db.getRun("run-attribution-failure")).toMatchObject({
        bot: "claude",
        status: "failed",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
