import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

let authenticated = false;

acp.agent({ name: "fake-codex-acp-auth-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    authMethods: [{ id: "api-key", name: "API key" }],
  }))
  .onRequest(acp.methods.agent.authenticate, async (ctx) => {
    if (ctx.params.methodId !== "api-key" || process.env.CODEX_API_KEY !== "valid-acp-key") {
      throw acp.RequestError.authRequired();
    }
    authenticated = true;
    return {};
  })
  .onRequest(acp.methods.agent.session.new, async () => {
    if (!authenticated) throw acp.RequestError.authRequired();
    return { sessionId: `acp-${randomUUID()}` };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    if (!authenticated) throw acp.RequestError.authRequired();
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "OK" },
      },
    });
    return { stopReason: "end_turn" };
  })
  .connect(stream);
