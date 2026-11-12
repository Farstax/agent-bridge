import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { connectWithAcpInitialization } from "./support/initializedAcpClient.js";
import { openDb } from "../src/db.js";
import { WorkspaceLockBusyError } from "../src/cli.js";
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
        providerChain: ["codex"] as const,
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

            // Provider notices are diagnostics, even when their title resembles
            // answer text. Existing outward clients must never receive them.
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
                    sessionUpdate: "notice",
                    severity: "warning",
                    title: "Model mismatch",
                    description: "Do not display or persist this notice as an answer",
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

      const response = await connectWithAcpInitialization(
        client,
        createOutwardAcpAgent({ sessions, promptExecutor, workspaceRoot: root }),
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
      expect(db.getAcpSessionBinding( { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:conversation" }, "codex")?.acpSessionId).toBe("provider-session");
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


  it("emits ordered, metadata-only fallback transitions without provider error text or transcript contamination", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-fallback-notices-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const session = sessions.create({ sessionId: "fallback-session", conversationId: "acp:fallback", cwd: root });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["claude", "codex", "grok"] as const,
        runId: () => "fallback-run",
        createEngine: (_session, provider) => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.collect(eventType.runStarted({
              runId: input.runId, bot: provider, chatId: String(input.chatId),
              chatKey: input.chatKey, command: provider, cwd: root, model: null,
            }));
            if (provider === "claude") throw new Error("rate limit capacity exhausted");
            if (provider === "codex") throw new Error("authentication required");
            input.collect(eventType.runCompleted({
              runId: input.runId, bot: provider, chatId: String(input.chatId),
              chatKey: input.chatKey, text: "completed", sessionId: "grok-session",
            }));
            return { text: "completed", sessionId: "grok-session", stopReason: "end_turn" };
          },
        }),
      });
      const updates: acp.SessionNotification[] = [];
      const client = acp.client({ name: "fallback-markers" })
        .onNotification(acp.methods.client.session.update, (ctx) => updates.push(ctx.params));
      const response = await connectWithAcpInitialization(
        client, createOutwardAcpAgent({ sessions, promptExecutor: executor, workspaceRoot: root }),
        async (agent) => {
          await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          return agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId, prompt: [{ type: "text", text: "ship task" }],
          });
        },
      );
      expect(response.stopReason).toBe("end_turn");
      const markers = updates.filter((item) => (item.update as any)._meta?.["agent-bridge/provider-fallback"]);
      expect(markers.map((item) => (item.update as any)._meta["agent-bridge/provider-fallback"])).toEqual([
        { fromProvider: "claude", toProvider: "codex", reason: "capacity" },
        { fromProvider: "codex", toProvider: "grok", reason: "auth_required" },
      ]);
      expect(markers.every((item) => (item.update as any).content?.text === "")).toBe(true);
      expect(updates[updates.length - 1].update).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "completed" } });
      expect(JSON.stringify(updates)).not.toContain("rate limit capacity exhausted");
      expect(JSON.stringify(updates)).not.toContain("authentication required");
      expect(JSON.stringify(db.getRecentConvTurns("acp:fallback", 10, undefined, OUTWARD_ACP_SURFACE))).not.toContain("provider-fallback");
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("forwards safe opted-in answer chunks over ACP before completion without duplicating the final answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-preview-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    let release!: () => void;
    const providerFinished = new Promise<void>((resolve) => { release = resolve; });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const session = sessions.create({ sessionId: "preview-session", conversationId: "acp:preview", cwd: root });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["codex"] as const,
        runId: () => "run-preview",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.onProviderExecutionStarted?.();
            input.onAnswerDelta?.("early safe answer");
            await providerFinished;
            return { text: "authoritative answer", sessionId: "provider-preview", stopReason: "end_turn" };
          },
        }),
      });
      const updates: acp.SessionNotification[] = [];
      let resolvePreview!: () => void;
      const gotPreview = new Promise<void>((resolve) => { resolvePreview = resolve; });
      const client = acp.client({ name: "farstax-desk-test" })
        .onNotification(acp.methods.client.session.update, (ctx) => {
          updates.push(ctx.params);
          if (ctx.params.update.sessionUpdate === "agent_message_chunk"
            && ctx.params.update.content.type === "text"
            && ctx.params.update.content.text === "early safe answer") resolvePreview();
        });
      const response = await connectWithAcpInitialization(
        client, createOutwardAcpAgent({ sessions, promptExecutor: executor, workspaceRoot: root }),
        async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
          });
          const running = agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }],
            _meta: { "agent-bridge/answer-preview": 1 },
          });
          try {
            await Promise.race([
              gotPreview,
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("preview was not streamed before completion")), 2500)),
            ]);
            expect(db.getRun("run-preview")?.status).toBe("running");
          } finally {
            release();
          }
          return running;
        },
      );
      expect(response.stopReason).toBe("end_turn");
      expect(updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk"))
        .toHaveLength(1);
      expect(db.getRecentConvTurns("acp:preview", 5, undefined, OUTWARD_ACP_SURFACE)
        .some((turn) => turn.role === "assistant" && turn.text === "authoritative answer")).toBe(true);
    } finally {
      release();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("notifies the matching ordinary ACP operation after durable admission, before provider completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-ordinary-receipt-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    let release!: () => void;
    const providerFinished = new Promise<void>((resolve) => { release = resolve; });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      const session = sessions.create({ sessionId: "ordinary-session", conversationId: "acp:ordinary", cwd: root });
      const executor = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["codex"] as const, runId: () => "run-ordinary",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            await providerFinished;
            return { text: "done", sessionId: "provider-ordinary", stopReason: "end_turn" };
          },
        }),
      });
      const updates: acp.SessionNotification[] = [];
      let received!: () => void;
      const gotReceipt = new Promise<void>((resolve) => { received = resolve; });
      const client = acp.client({ name: "farstax-desk-test" })
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          updates.push(params);
          const meta = (params.update as { _meta?: Record<string, unknown> })._meta;
          if (meta?.["agent-bridge/prompt-accepted"]) received();
        });
      const response = await connectWithAcpInitialization(
        client, createOutwardAcpAgent({ sessions, promptExecutor: executor, workspaceRoot: root }),
        async (agent) => {
          await agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
          });
          const running = agent.request(acp.methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
            _meta: { "agent-bridge/busy-messages": 1, "agent-bridge/request-id": "ordinary-op-1" },
          });
          try {
            await Promise.race([
              gotReceipt,
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no early durable receipt")), 2500)),
            ]);
            expect(db.getRun("run-ordinary")?.status).toBe("running");
            expect(db.getRecentConvTurns("acp:ordinary", 5, undefined, OUTWARD_ACP_SURFACE)
              .some((turn) => turn.role === "user" && turn.text === "hello")).toBe(true);
            expect(updates.filter((item) => (item.update as { _meta?: Record<string, unknown> })._meta?.["agent-bridge/prompt-accepted"]))
              .toEqual([{
                sessionId: "ordinary-session",
                update: {
                  sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" },
                  _meta: { "agent-bridge/prompt-accepted": { requestId: "ordinary-op-1", runId: "run-ordinary" } },
                },
              }]);
          } finally { release(); }
          return running;
        },
      );
      expect(response.stopReason).toBe("end_turn");
    } finally {
      release();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets a safe preview on retry and cancellation without exposing a stale final", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-preview-reset-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "reset-session", conversationId: "acp:reset", cwd: root,
      });
      const updates: acp.SessionNotification["update"][] = [];
      const executor = new BridgeOutwardAcpPromptExecutor({
        db, providerChain: ["codex"] as const, runId: () => "run-reset",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            input.onProviderExecutionStarted?.();
            input.onAnswerDelta?.("abandoned");
            input.onProviderExecutionStarted?.();
            input.onAnswerDelta?.("current");
            return { text: "current authoritative answer", sessionId: "provider-reset", stopReason: "cancelled" };
          },
        }),
      });
      const response = await executor.execute({
        session, prompt: "retry", signal: new AbortController().signal,
        answerPreview: true, onUpdate: (update) => { updates.push(update); },
      });
      expect(response.stopReason).toBe("cancelled");
      expect(updates.map((update) => (
        update.sessionUpdate === "agent_message_chunk" ? update.content.text : ""
      ))).toEqual(["abandoned", "", "current", ""]);
      expect((updates[1] as { _meta?: Record<string, unknown> })._meta?.["agent-bridge/preview-reset"]).toBe(1);
      expect((updates[3] as { _meta?: Record<string, unknown> })._meta?.["agent-bridge/preview-reset"]).toBe(1);
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
        providerChain: ["codex"] as const,
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

      const response = await connectWithAcpInitialization(
        client,
        createOutwardAcpAgent({ sessions, promptExecutor, workspaceRoot: root }),
        (agent) => agent.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "cancel me" }],
        }),
      );

      expect(response.stopReason).toBe("cancelled");
      expect(updates).toEqual([]);
      expect(db.getRun("run-cancel")?.status).toBe("cancelled");
      expect(db.getAcpSessionBinding( { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "acp:cancel" }, "codex")?.acpSessionId).toBe("provider-cancel");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts resource_link metadata and stages embedded image prompt blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-prompt-content-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const sessions = new OutwardAcpSessionRepository(db.raw);
      sessions.create({ sessionId: "known", conversationId: "acp:known", cwd: root });
      let executions = 0;
      let capturedPrompt = "";
      const promptExecutor = {
        async execute(input: { prompt: string }): Promise<acp.PromptResponse> {
          executions += 1;
          capturedPrompt = input.prompt;
          return { stopReason: "end_turn" };
        },
        async cancel(): Promise<"confirmed"> { return "confirmed"; },
      };
      const client = acp.client({ name: "outward-test-client" });
      const app = createOutwardAcpAgent({ sessions, promptExecutor, workspaceRoot: root });

      await expect(connectWithAcpInitialization(client, app, (agent) => agent.request(acp.methods.agent.session.prompt, {
        sessionId: "missing",
        prompt: [{ type: "text", text: "hi" }],
      }))).rejects.toMatchObject({ code: -32602 });

      const resource = await connectWithAcpInitialization(client, app, (agent) => agent.request(acp.methods.agent.session.prompt, {
        sessionId: "known",
        prompt: [
          { type: "text", text: "Read this resource." },
          {
            type: "resource_link",
            name: "workspace notes",
            uri: "file:///workspace/notes.md",
            mimeType: "text/markdown",
          },
        ],
      }));
      expect(resource.stopReason).toBe("end_turn");
      expect(executions).toBe(1);
      expect(capturedPrompt).toContain("Read this resource.");
      expect(capturedPrompt).toContain("[ACP resource_link]");
      expect(capturedPrompt).toContain("file:///workspace/notes.md");
      expect(capturedPrompt).toContain("workspace notes");

      const image = await connectWithAcpInitialization(client, app, (agent) => agent.request(acp.methods.agent.session.prompt, {
        sessionId: "known",
        prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      }));
      expect(image.stopReason).toBe("end_turn");
      expect(executions).toBe(2);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles an already-aborted request as a user cancellation without starting the provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-pre-cancel-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-pre-cancel",
        conversationId: "acp:pre-cancel",
        cwd: root,
      });
      let executed = false;
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex"] as const,
        runId: () => "run-pre-cancel",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            executed = true;
            return { text: "must not run", sessionId: null, stopReason: "end_turn" };
          },
        }),
      });
      const controller = new AbortController();
      controller.abort();

      const response = await executor.execute({
        session,
        prompt: "cancelled before dispatch",
        signal: controller.signal,
        onUpdate: () => undefined,
      });

      expect(response.stopReason).toBe("cancelled");
      expect(executed).toBe(false);
      expect(db.getRun("run-pre-cancel")?.status).toBe("cancelled");
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
      db.insertRun("duplicate-run", { surfaceIdentity: OUTWARD_ACP_SURFACE, chatKey: "other-conversation" }, "codex");
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-run-admission",
        conversationId: "acp:run-admission",
        cwd: root,
      });
      let executed = false;
      const promptExecutor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex"] as const,
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
        signal: new AbortController().signal,
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

  it("reports host execution-slot exhaustion as busy without wrapping or provider fallback (#1151)", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-host-capacity-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-capacity",
        conversationId: "acp:host-capacity",
        cwd: root,
      });
      let attempts = 0;
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex", "claude"] as const,
        runId: () => "run-host-capacity",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            attempts += 1;
            const error = new Error("all provider execution slots are occupied");
            error.name = "ProviderExecutionCapacityError";
            throw error;
          },
        }),
      });
      await expect(executor.execute({
        session,
        prompt: "hello",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      })).rejects.toMatchObject({
        code: -32002,
        message: "outward ACP execution capacity is occupied",
        data: expect.objectContaining({ reason: "execution_capacity", runId: "run-host-capacity" }),
      });
      expect(attempts).toBe(1);
      expect(db.getRun("run-host-capacity")).toMatchObject({ status: "failed" });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a held Git worktree as busy: failed Run, no fallback, no capacity wait, lane released", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-worktree-busy-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-worktree-busy",
        conversationId: "acp:worktree-busy",
        cwd: root,
      });
      let attempts = 0;
      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex", "claude"] as const,
        runId: () => "run-worktree-busy",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async () => {
            attempts += 1;
            throw new WorkspaceLockBusyError();
          },
        }),
      });
      await expect(executor.execute({
        session,
        prompt: "hello",
        signal: new AbortController().signal,
        deferCapacity: true,
        onUpdate: () => undefined,
      })).rejects.toMatchObject({
        code: -32002,
        data: expect.objectContaining({ reason: "workspace_busy", runId: "run-worktree-busy" }),
      });
      expect(attempts).toBe(1);
      // A busy worktree is a failure of this Run, never a user cancellation.
      expect(db.getRun("run-worktree-busy")).toMatchObject({ status: "failed" });
      const reacquired = db.acquireLock(OUTWARD_ACP_SURFACE, session.conversationId);
      expect(reacquired).not.toBeNull();
      if (reacquired) db.unlock(reacquired);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
