import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const app = acp.agent({ name: "system-error-acp-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-system-error-process" }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        threadStatus: { type: "systemError" },
      } as any,
    });
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "You've hit your usage limit. Try again later." },
      },
    });
    return { stopReason: "end_turn" };
  });

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

void app.connect(stream);
