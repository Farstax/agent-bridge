import * as acp from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import { capacityRetryAfterSeconds } from "../src/providers/capacityRetryTiming.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";
import { decideProviderRecovery } from "../src/providers/recoveryVerdict.js";

const BANNER = "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 5 days, 18 hours.";

function textAgent(text: string): acp.AgentApp {
  return acp.agent({ name: "in-band-text-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-in-band" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      return { stopReason: "end_turn" };
    });
}

async function run(providerId: string, text: string) {
  return runAcpTurn({
    providerId, peer: textAgent(text), cwd: process.cwd(), conversationId: "c", runId: "r",
    existingAcpSessionId: null, prompt: "hi", executionMode: "trusted",
  });
}

describe("provider-scoped in-band failure text", () => {
  it("raises Agy's complete quota banner as a capacity failure with a parsed reset", async () => {
    const error = await run("agy", BANNER).then(() => null, (e: Error) => e);
    expect(error?.name).toBe("AcpSystemError");
    expect(decideProviderRecovery("agy", error!)).toMatchObject({ reason: "capacity", capacityExhausted: true });
    const retry = capacityRetryAfterSeconds(error);
    expect(retry).toBeGreaterThan((5 * 24 + 17) * 3600);
    expect(retry).toBeLessThan((5 * 24 + 19) * 3600);
  });

  it("recognizes only a complete individual-quota reply", async () => {
    const error = await run("agy", "Individual quota reached").then(() => null, (e: Error) => e);
    expect(error?.name).toBe("AcpSystemError");
    expect(decideProviderRecovery("agy", error!)).toMatchObject({ reason: "capacity", capacityExhausted: true });
    expect((await run("agy", "The provider said: Individual quota reached")).liveText)
      .toContain("Individual quota reached");
  });

  it("raises the Agy 1.5.15 individual-quota banner with its compact reset", async () => {
    const text = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 115h15m3s.";
    const error = await run("agy", text).then(() => null, (e: Error) => e);
    expect(error?.name).toBe("AcpSystemError");
    expect(decideProviderRecovery("agy", error!)).toMatchObject({ reason: "capacity", capacityExhausted: true });
    const retry = capacityRetryAfterSeconds(error);
    expect(retry).toBeGreaterThan(115 * 3600);
    expect(retry).toBeLessThan(116 * 3600);
    expect((await run("agy", `${text}\n\nHere is my analysis.`)).liveText).toContain("Here is my analysis.");
  });

  it("falls back to unknown timing when the banner has no parseable reset", async () => {
    const error = await run("agy", "Usage Limit Reached\n\nYou have reached your current quota for this period.").then(() => null, (e: Error) => e);
    expect(classifyProviderError("agy", error!).kind).toBe("capacity_exhausted");
    expect(capacityRetryAfterSeconds(error)).toBeNull();
  });

  it.each([
    ["quoted excerpt", `The runtime printed:\n> ${BANNER}\nThat is not handled.`],
    ["partial banner", "Usage Limit Reached"],
    ["trailing answer", `${BANNER}\n\nHere is my analysis.`],
    ["ordinary discussion", "You have reached your usage limit on Codex."],
  ])("delivers Agy text unchanged: %s", async (_name, text) => {
    expect((await run("agy", text)).liveText).toBe(text);
  });

  it.each(["claude", "codex", "grok"])("does not apply Agy detection to %s", async (provider) => {
    expect((await run(provider, BANNER)).liveText).toBe(BANNER);
    const marker = "Agent execution error: could not find doneCh for checkpoint";
    expect((await run(provider, marker)).liveText).toBe(marker);
  });

  it("still fails Agy checkpoint corruption as transient", async () => {
    const error = await run("agy", "Agent execution error: could not find doneCh for checkpoint").then(() => null, (e: Error) => e);
    expect(classifyProviderError("agy", error!).kind).toBe("transient");
  });
});
