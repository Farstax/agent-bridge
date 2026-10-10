import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// SCRIPTED_ACP_MODE:
//   setup-fail             every process fails during session/new
//   prompt-then-setup-fail first process fails after session/prompt, later processes fail during session/new
const mode = process.env.SCRIPTED_ACP_MODE;
const counter = process.env.SCRIPTED_ACP_COUNTER;
function processIndex(): number {
  if (!counter) return 0;
  const previous = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(previous + 1));
  return previous;
}
const index = processIndex();

const app = acp.agent({ name: "scripted-acp-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
  }))
  .onRequest(acp.methods.agent.session.new, async () => {
    if (mode === "setup-fail" || (mode === "prompt-then-setup-fail" && index > 0)) {
      throw new Error("Internal error: scripted session setup failure");
    }
    return { sessionId: `scripted-${index}` };
  })
  .onRequest(acp.methods.agent.session.prompt, async () => {
    throw new Error("Internal error: scripted failure after prompt submission");
  });

void app.connect(acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
));
