import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent } from "../src/acpServer/app.js";
import {
  BridgeOutwardAcpPromptExecutor,
  createProductionOutwardAcpPromptExecutor,
  OUTWARD_ACP_SURFACE,
} from "../src/acpServer/execution.js";

describe("outward ACP prompt execution", () => {
  it("keeps provider identity private, suppresses replay/provisional text, and forwards live structured updates", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-prompt-"));
    const dbPath = join(root, "bridge.sqlite");
    const db = openDb(dbPath, { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const session = sessions.create({
        sessionId: "outward-session",
        conversationId: "acp:conversation",
        cwd: root,
      });
      const promptExecutor = new BridgeOutwardAcpPromptExecutor({
        db,
        provider: "codex",
        runId: () => "run-1",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.collect(eventType.runStarted({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              command: "codex-acp",
              cwd: root,
              model: null,
            }));
            input.collect(eventType.acpEvent({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              sessionId: "provider-session",
              sessionMode: "load",
              event: {
                kind: "session_update",
                channel: "replay",
                acpSessionId: "provider-session",
                sessionMode: "load",
                notification: {
                  sessionId: "provider-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "old replayed answer" },
                  },
                },
              },
            }));
            input.collect(eventType.acpEvent({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              sessionId: "provider-session",
              sessionMode: "load",
              event: {
                kind: "session_update",
                channel: "live",
                acpSessionId: "provider-session",
                sessionMode: "load",
                notification: {
                  sessionId: "provider-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "provider commentary" },
                    _meta: { codex: { phase: "commentary" } },
                  },
                },
              },
            }));
            input.collect(eventType.acpEvent({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              sessionId: "provider-session",
              sessionMode: "load",
              event: {
                kind: "session_update",
                channel: "live",
                acpSessionId: "provider-session",
                sessionMode: "load",
                notification: {
                  sessionId: "child-session",
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "child-call",
                    title: "child work",
                    kind: "think",
                    status: "completed",
                  },
                },
              },
            }));
            input.collect(eventType.acpEvent({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              sessionId: "provider-session",
              sessionMode: "load",
              event: {
                kind: "session_update",
                channel: "live",
                acpSessionId: "provider-session",
                sessionMode: "load",
                notification: {
                  sessionId: "provider-session",
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: "root-call",
                    title: "root work",
                    kind: "think",
                    status: "completed",
                  },
                },
              },
            }));
            input.collect(eventType.runCompleted({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              text: "hello",
              sessionId: "provider-session",
            }));
            return { text: "hello", sessionId: "provider-session", stopReason: "end_turn" };
          },
        }),
      });
      const updates: acp.SessionNotification[] = [];
      const client = acp.client({ name: "outward-test-client" })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          updates.push(ctx.params);
        });

      const response = await client.connectWith(
        createOutwardAcpAgent({ sessions, promptExecutor }),
        async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {},
          });
          return agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hi" }],
          });
        },
      );

      expect(response.stopReason).toBe("end_turn");
      expect(updates).toEqual([
        {
          sessionId: "outward-session",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "root-call",
            title: "root work",
            kind: "think",
            status: "completed",
          },
        },
        {
          sessionId: "outward-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
          },
        },
      ]);
      expect(JSON.stringify(updates)).not.toContain("old replayed answer");
      expect(JSON.stringify(updates)).not.toContain("provider commentary");
      expect(JSON.stringify(updates)).not.toContain("child-call");
      expect(updates.every((update) => update.sessionId !== "provider-session")).toBe(true);
      expect(db.getAcpSessionBinding("acp:conversation", "codex")?.acpSessionId).toBe("provider-session");
      expect(db.getRun("run-1")).toMatchObject({
        run_id: "run-1",
        chat_id: "acp:conversation",
        status: "done",
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never publishes provider partial answer text when the turn is cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-prompt-cancel-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const session = sessions.create({ sessionId: "outward-cancel", conversationId: "acp:cancel", cwd: root });
      const promptExecutor = new BridgeOutwardAcpPromptExecutor({
        db,
        provider: "codex",
        runId: () => "run-cancel",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.collect(eventType.acpEvent({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              sessionId: "provider-cancel",
              sessionMode: "fresh",
              event: {
                kind: "session_update",
                channel: "live",
                acpSessionId: "provider-cancel",
                sessionMode: "fresh",
                notification: {
                  sessionId: "provider-cancel",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "partial answer that must not escape" },
                  },
                },
              },
            }));
            input.collect(eventType.runCancelled({
              runId: input.runId,
              bot: "codex",
              chatId: String(input.chatId),
              chatKey: input.chatKey,
              reason: "provider",
            }));
            return {
              text: "partial answer that must not escape",
              sessionId: "provider-cancel",
              stopReason: "cancelled",
            };
          },
        }),
      });
      const updates: acp.SessionNotification[] = [];
      const client = acp.client({ name: "outward-test-client" })
        .onNotification(acp.methods.client.session.update, (ctx) => updates.push(ctx.params));

      const response = await client.connectWith(
        createOutwardAcpAgent({ sessions, promptExecutor }),
        (agent) => agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "cancel me" }],
        }),
      );

      expect(response.stopReason).toBe("cancelled");
      expect(updates).toEqual([]);
      expect(db.getRun("run-cancel")?.status).toBe("cancelled");
      expect(db.getAcpSessionBinding("acp:cancel", "codex")?.acpSessionId).toBe("provider-cancel");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for unknown sessions and non-text prompt blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-prompt-invalid-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      sessions.create({ sessionId: "known", conversationId: "acp:known", cwd: root });
      let executions = 0;
      const promptExecutor = {
        async execute(): Promise<acp.PromptResponse> {
          executions += 1;
          return { stopReason: "end_turn" };
        },
      };
      const client = acp.client({ name: "outward-test-client" });
      const app = createOutwardAcpAgent({ sessions, promptExecutor });

      await expect(client.connectWith(app, (agent) => agent.request(acp.methods.agent.session.prompt, {
        sessionId: "missing",
        prompt: [{ type: "text", text: "hi" }],
      }))).rejects.toMatchObject({ code: -32602 });

      await expect(client.connectWith(app, (agent) => agent.request(acp.methods.agent.session.prompt, {
        sessionId: "known",
        prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }))).rejects.toMatchObject({ code: -32602 });
      expect(executions).toBe(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed instead of silently weakening an invalid provider lock", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-provider-lock-"));
    const dbPath = join(root, "bridge.sqlite");
    const db = openDb(dbPath, { databaseRole: "interactive" });
    try {
      expect(() => createProductionOutwardAcpPromptExecutor(db, dbPath, {
        BRIDGE_PROVIDER_LOCK: "not-a-provider",
      })).toThrow(/unsupported outward ACP provider lock/);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the outward lane when durable Run admission fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-run-admission-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      db.insertRun("duplicate-run", "other-conversation", "codex");
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-run-admission",
        conversationId: "acp:run-admission",
        cwd: root,
      });
      let executed = false;
      const promptExecutor = new BridgeOutwardAcpPromptExecutor({
        db,
        provider: "codex",
        runId: () => "duplicate-run",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            executed = true;
            return { text: "must not run", sessionId: null, stopReason: "end_turn" };
          },
        }),
      });

      await expect(promptExecutor.execute({
        session,
        prompt: "hi",
        onUpdate: () => undefined,
      })).rejects.toMatchObject({ code: -32001 });
      expect(executed).toBe(false);

      const reacquired = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId);
      expect(reacquired).not.toBeNull();
      if (reacquired) db.unlock(reacquired);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
