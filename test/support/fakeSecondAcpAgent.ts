import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
let authenticated = false;
const loadedSessions = new Set<string>();

acp.agent({ name: "fake-second-acp-provider" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    authMethods: [{ id: "workspace-token", name: "Workspace token" }],
  }))
  .onRequest(acp.methods.agent.authenticate, async (ctx) => {
    if (ctx.params.methodId !== "workspace-token") throw acp.RequestError.authRequired();
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    if (!authenticated) throw acp.RequestError.authRequired();
    return { sessionId: "fixture-root-session" };
  })
  .onRequest(acp.methods.agent.session.load, async (ctx) => {
    if (!authenticated) throw acp.RequestError.authRequired();
    loadedSessions.add(ctx.params.sessionId);
    return { sessionId: ctx.params.sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (!authenticated) throw acp.RequestError.authRequired();
    const prompt = ctx.params.prompt
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
    if (prompt.includes("FAIL_WITH_SECRET")) {
      throw acp.RequestError.internalError({
        nested: { credential: process.env.XAI_API_KEY ?? "missing" },
      });
    }
    if (prompt.includes("CANCEL")) return { stopReason: "cancelled" };
    if (prompt.includes("PERMISSION_PROBE")) {
      const decision = await ctx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: ctx.params.sessionId,
        toolCall: { toolCallId: "perm-1", title: "Test Tool", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      const selectedId = (decision as { outcome?: { optionId?: string } })?.outcome?.optionId ?? "unknown";
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `permission decision:${selectedId}` },
        },
      });
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    }
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: "fixture-child-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "private child output" },
      },
    });
    const answerText = loadedSessions.has(ctx.params.sessionId)
      ? `fixture resumed answer:${ctx.params.sessionId}`
      : "fixture parent answer";
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: answerText },
      },
    });
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  })
  .connect(stream);
