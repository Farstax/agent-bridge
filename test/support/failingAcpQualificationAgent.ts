import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp.agent({ name: "failing-acp-qualification-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
    },
    authMethods: [{ id: "api-key", name: "API key" }],
  }))
  .onRequest(acp.methods.agent.authenticate, async () => ({}))
  .onRequest(acp.methods.agent.session.new, async () => ({
    sessionId: `acp-${randomUUID()}`,
  }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    // The Bridge auth probe (codexAcpAuthProbe.ts) sends this exact bounded
    // prompt before qualification's own fresh_prompt turn. It must succeed so
    // CODEX_API_KEY verification passes and the credential actually reaches
    // this fixture's env for the qualification turn below to redact.
    const text = ctx.params.prompt.find((block) => block.type === "text")?.text;
    if (text === "Reply with exactly OK.") {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } },
      });
      return { stopReason: "end_turn" };
    }
    throw acp.RequestError.internalError({
      message: "usage limit reached",
      additionalDetails: `credential=${process.env.CODEX_API_KEY ?? "none"}`,
      codexErrorInfo: "usageLimitExceeded",
    });
  })
  .connect(stream);
