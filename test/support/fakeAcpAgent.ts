import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";


interface FakeSession {
  history: Array<{ role: "user" | "agent"; text: string }>;
  pending: AbortController | null;
}

export interface FakeAcpAgentOptions {
  loadSession?: boolean;
  resume?: boolean;
  close?: boolean;
  permissionOn?: string;
  onClose?: () => void;
  initializeError?: Error;
  /** Emit only the session/update usage_update notification; omit PromptResponse.usage. */
  usageUpdateOnly?: boolean;
  /** Negotiated agentCapabilities.promptCapabilities. Omitted fields default to unsupported. */
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
}

function persistSessions(sessions: Map<string, FakeSession>): void {
  const path = process.env.FAKE_ACP_STORE;
  if (!path) return;
  writeFileSync(path, JSON.stringify([...sessions.entries()].map(([id, session]) => [id, { history: session.history }])));
}

function restoreSessions(): Map<string, FakeSession> {
  const path = process.env.FAKE_ACP_STORE;
  const sessions = new Map<string, FakeSession>();
  if (!path || !existsSync(path)) return sessions;
  const rows = JSON.parse(readFileSync(path, "utf8")) as Array<[string, { history: FakeSession["history"] }]>;
  for (const [id, session] of rows) sessions.set(id, { history: session.history, pending: null });
  return sessions;
}

export function createFakeAcpAgent(options: FakeAcpAgentOptions = {}): acp.AgentApp {
  const sessions = restoreSessions();

  const get = (sessionId: string): FakeSession => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  };

  return acp.agent({ name: "fake-acp-agent" })
    .onRequest(acp.methods.agent.initialize, async () => {
      if (options.initializeError) throw options.initializeError;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: options.loadSession ?? true,
          sessionCapabilities: {
            ...(options.resume ? { resume: {} } : {}),
            ...(options.close ? { close: {} } : {}),
          },
          ...(options.promptCapabilities ? { promptCapabilities: options.promptCapabilities } : {}),
        },
      };
    })
    .onRequest(acp.methods.agent.session.new, async () => {
      const sessionId = `acp-${randomUUID()}`;
      sessions.set(sessionId, { history: [], pending: null });
      persistSessions(sessions);
      return {
        sessionId,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "read-only", name: "Read Only" },
            { id: "agent-full-access", name: "Full Access" },
          ],
        },
      };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      const session = get(ctx.params.sessionId);
      for (const item of session.history) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: item.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: item.text },
          },
        });
      }
      return {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "read-only", name: "Read Only" },
            { id: "agent-full-access", name: "Full Access" },
          ],
        },
      };
    })
    .onRequest(acp.methods.agent.session.setMode, async () => {
      return {};
    })
    .onRequest(acp.methods.agent.session.resume, async (ctx) => {
      // ACP v1: session/resume never replays previous messages, unlike
      // session/load. get() proves the session exists; nothing is emitted.
      get(ctx.params.sessionId);
      return {
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "read-only", name: "Read Only" },
            { id: "agent-full-access", name: "Full Access" },
          ],
        },
      };
    })
    .onRequest(acp.methods.agent.session.close, async () => {
      options.onClose?.();
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = get(ctx.params.sessionId);
      session.pending?.abort();
      session.pending = new AbortController();
      const text = ctx.params.prompt
        .map((block) => block.type === "text" ? block.text : "")
        .join("");
      session.history.push({ role: "user", text });

      if (text.includes("THROW_CREDENTIAL_ERROR")) {
        throw acp.RequestError.internalError({
          message: "usage limit reached",
          additionalDetails: `credential=${process.env.CODEX_API_KEY ?? "none"}`,
          codexErrorInfo: "usageLimitExceeded",
        });
      }

      if (text.includes("CANCEL_WITH_OUTPUT")) {
        const outputFile = process.env.FAKE_ACP_OUTPUT_FILE;
        if (!outputFile) throw new Error("FAKE_ACP_OUTPUT_FILE is required for CANCEL_WITH_OUTPUT");
        writeFileSync(outputFile, "partial output from provider-cancelled turn");
        return { stopReason: "cancelled" };
      }

      if (text.includes("HANG")) {
        await new Promise<void>((resolve, reject) => {
          const done = () => resolve();
          session.pending?.signal.addEventListener("abort", done, { once: true });
          ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: -32800 })), { once: true });
        });
        return { stopReason: "cancelled" };
      }

      if (options.permissionOn && text.includes(options.permissionOn)) {
        await ctx.client.request(acp.methods.client.session.requestPermission, {
          sessionId: ctx.params.sessionId,
          toolCall: {
            toolCallId: "call-perm",
            title: "Edit file",
            kind: "edit",
            status: "pending",
          },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        });
      }

      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "thinking",
          kind: "think",
          status: "completed",
          ...(process.env.FAKE_ACP_SECRET_PROBE
            ? {
              rawInput: { command: `curl -H "Authorization: Bearer ${process.env.FAKE_ACP_SECRET_PROBE}"` },
              rawOutput: { body: `used key ${process.env.FAKE_ACP_SECRET_PROBE}` },
            }
            : {}),
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "usage_update", used: 12, size: 100_000 },
      });
      if (text.includes("PHASED")) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "thinking out loud..." },
            _meta: { codex: { phase: "commentary" } },
          },
        });
      }
      let reply = `live:${text}`;
      if (text.includes("repository-grounding qualification")) {
        const source = readFileSync("src/repositoryGroundingFixture.ts", "utf8");
        const instructions = readFileSync("AGENTS.md", "utf8");
        reply = `${source}\n${instructions}`;
      }
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: reply },
          ...(text.includes("PHASED") ? { _meta: { codex: { phase: "final_answer" } } } : {}),
        },
      });
      session.history.push({ role: "agent", text: reply });
      persistSessions(sessions);
      return options.usageUpdateOnly
        ? { stopReason: "end_turn" }
        : {
          stopReason: "end_turn",
          usage: { totalTokens: 12, inputTokens: 4, outputTokens: 8, thoughtTokens: 1 },
        };
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.pending?.abort();
    });
}

export function startFakeAcpStdioServer(): void {
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  createFakeAcpAgent({
    loadSession: true,
    resume: process.env.FAKE_ACP_RESUME === "1",
    close: true,
    permissionOn: process.env.FAKE_ACP_PERMISSION_ON,
  }).connect(stream);
}

const isMain = Boolean((import.meta as ImportMeta & { main?: boolean }).main)
  || process.argv.some((arg) => arg.includes("fakeAcpAgent"));
if (isMain) startFakeAcpStdioServer();
