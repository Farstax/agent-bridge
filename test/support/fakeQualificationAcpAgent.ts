import * as acp from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

/**
 * Fake ACP agent for provider-qualification tests. Every real provider is
 * ACP-transport now, so qualifyProvider()'s bounded fresh/resume/grounding
 * probes speak real ACP JSON-RPC over stdio -- a plain oneshot script that
 * just prints JSON to stdout (the old native-CLI fixture shape) never
 * receives or answers those requests. This agent implements just enough of
 * the protocol to drive each qualification scenario deterministically,
 * selected via FAKE_ACP_MODE.
 *
 * Modes:
 *   pass              -- fresh/resume probes get a normal reply + session id.
 *   missing_session   -- session/prompt throws a "session"-mentioning error.
 *   malformed         -- writes an invalid JSON-RPC frame directly to stdout.
 *   capacity          -- throws an error containing "usage limit" (matches
 *                        capacity-classification patterns).
 *   grounding_pass | grounding_omit_instruction | grounding_omit_source --
 *     for the repository-grounding probe, replies with fact+marker, fact
 *     only, or marker only (read from the qualification fixture's cwd).
 */

if (process.argv.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_ACP_VERSION ?? "1.0.0"}\n`);
  process.exit(0);
}

const mode = process.env.FAKE_ACP_MODE ?? "pass";

function readGroundingFixture(): { fact: string; marker: string } {
  const fact = readFileSync(join(process.cwd(), "src", "repositoryGroundingFixture.ts"), "utf8")
    .match(/"([^"]+)"/)?.[1] ?? "";
  const marker = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8")
    .match(/AGENT_BRIDGE_GROUNDING_INSTRUCTION_[A-Za-z0-9]*/)?.[0] ?? "";
  return { fact, marker };
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

acp.agent({ name: "fake-qualification-acp-agent" })
  .onRequest(acp.methods.agent.initialize, async () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false, sessionCapabilities: { resume: true } },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, async () => ({
    sessionId: randomUUID(),
    modes: {
      currentModeId: "ask",
      availableModes: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask" },
      ],
    },
  }))
  .onRequest(acp.methods.agent.session.resume, async (ctx) => ({
    sessionId: ctx.params.sessionId,
    modes: {
      currentModeId: "ask",
      availableModes: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask" },
      ],
    },
  }))
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt.map((block) => block.type === "text" ? block.text : "").join("");
    const isGrounding = prompt.includes("Agent Bridge repository-grounding qualification.");

    if (mode === "missing_session") {
      throw acp.RequestError.internalError({ message: "session identity missing from provider response" });
    }
    if (mode === "malformed") {
      process.stdout.write("{not-json\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.exit(1);
    }
    if (isGrounding && mode === "capacity") {
      throw acp.RequestError.internalError({ message: "usage limit reached" });
    }

    let text = "native protocol response";
    if (isGrounding) {
      const { fact, marker } = readGroundingFixture();
      text = mode === "grounding_omit_instruction" ? fact
        : mode === "grounding_omit_source" ? marker
        : `${fact} ${marker}`;
    }

    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
    return { stopReason: "end_turn" };
  })
  .connect(stream);
