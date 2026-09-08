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
  }))
  .onRequest(acp.methods.agent.session.new, async () => ({
    sessionId: `acp-${randomUUID()}`,
  }))
  .onRequest(acp.methods.agent.session.prompt, async () => {
    throw acp.RequestError.internalError({
      message: "usage limit reached",
      additionalDetails: `credential=${process.env.CODEX_API_KEY ?? "none"}`,
      codexErrorInfo: "usageLimitExceeded",
    });
  })
  .connect(stream);
