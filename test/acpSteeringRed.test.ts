import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runAcpTurn } from "../src/acp/index.js";

describe("ACP steering red", () => {
  it("exposes an active steering callback when the agent advertises the extension", async () => {
    const peer = acp.agent({ name: "steering-red-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
        _meta: { steering: { supported: true } },
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-steering-red" }))
      .onRequest(acp.methods.agent.session.prompt, async () => ({ stopReason: "end_turn" }));

    let exposed = false;
    await runAcpTurn({
      peer,
      cwd: process.cwd(),
      conversationId: "conversation-steering-red",
      runId: "run-steering-red",
      existingAcpSessionId: null,
      prompt: "start",
      executionMode: "trusted",
      onSteeringReady: (steer: unknown) => { exposed ||= typeof steer === "function"; },
    } as any);

    expect(exposed).toBe(true);
  });
});
