import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { openDb } from "../src/db.js";
import { type as eventType } from "../src/events/types.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";
import { createOutwardAcpAgent } from "../src/acpServer/app.js";
import { BridgeOutwardAcpPromptExecutor } from "../src/acpServer/execution.js";

describe("outward ACP prompt execution", () => {
  it("keeps provider session identity private while forwarding root ACP updates on the outward session", async () => {
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
              sessionMode: "fresh",
              event: {
                kind: "session_update",
                acpSessionId: "provider-session",
                sessionMode: "fresh",
                notification: {
                  sessionId: "provider-session",
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "hello" },
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
      expect(updates).toEqual([{
        sessionId: "outward-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      }]);
      expect(updates[0]?.sessionId).not.toBe("provider-session");
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
});
