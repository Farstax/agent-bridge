import { describe, expect, it } from "vitest";
import { AcpSessionMap, liveDeliveryText, runAcpTurn } from "../src/acp/index.js";
import { createFakeAcpAgent } from "./support/fakeAcpAgent.js";

describe("ACP core client", () => {
  it("creates a fresh session and keeps Bridge identity distinct from the ACP session id", async () => {
    const map = new AcpSessionMap();
    const result = await runAcpTurn({
      peer: createFakeAcpAgent({ loadSession: true, close: true }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "trusted",
    });

    map.bind({
      conversationId: result.conversationId,
      runId: result.runId,
      providerId: "codex",
      acpSessionId: result.acpSessionId,
    });

    expect(result.sessionMode).toBe("fresh");
    expect(result.stopReason).toBe("end_turn");
    expect(result.liveText).toBe("live:hello");
    expect(result.acpSessionId).toMatch(/^acp-/);
    expect(result.acpSessionId).not.toBe("conv-bridge-1");
    expect(map.lookup("conv-bridge-1", "codex")?.conversationId).toBe("conv-bridge-1");
    expect(result.events.some((event) => event.kind === "session_update" && event.notification?.update.sessionUpdate === "tool_call")).toBe(true);
    expect(result.usage?.outputTokens).toBe(8);
  });

  it("replays history on session/load without treating it as live delivery", async () => {
    const agent = createFakeAcpAgent({ loadSession: true, resume: false, close: true });
    const first = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "first",
      executionMode: "trusted",
    });

    const second = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: first.acpSessionId,
      prompt: "second",
      executionMode: "trusted",
    });

    expect(second.sessionMode).toBe("load");
    expect(second.acpSessionId).toBe(first.acpSessionId);
    expect(liveDeliveryText(second.updates)).toBe("live:second");
    expect(second.liveText).toBe("live:second");
    expect(second.updates.some((update) => update.channel === "replay" && liveTextOf(update) === "live:first")).toBe(true);
    expect(second.liveText).not.toContain("first");
  });

  it("prefers session/resume when advertised so history is not replayed", async () => {
    const agent = createFakeAcpAgent({ loadSession: true, resume: true, close: true });
    const first = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "first",
      executionMode: "trusted",
    });
    const second = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: first.acpSessionId,
      prompt: "second",
      executionMode: "trusted",
    });
    expect(second.sessionMode).toBe("resume");
    expect(second.updates.every((update) => update.channel === "live")).toBe(true);
    expect(second.liveText).toBe("live:second");
  });

  it("maps permission requests through Bridge authority and retains the event", async () => {
    const trusted = await runAcpTurn({
      peer: createFakeAcpAgent({ permissionOn: "PERM" }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "PERM please",
      executionMode: "trusted",
    });
    expect(trusted.events.some((event) => event.kind === "permission")).toBe(true);

    const safe = await runAcpTurn({
      peer: createFakeAcpAgent({ permissionOn: "PERM" }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: null,
      prompt: "PERM please",
      executionMode: "safe",
    });
    expect(safe.events.some((event) => event.kind === "permission")).toBe(true);
    expect(safe.stopReason).toBe("end_turn");
  });

  it("cancels an in-flight prompt via session/cancel", async () => {
    const abort = new AbortController();
    const hung = runAcpTurn({
      peer: createFakeAcpAgent(),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "HANG",
      executionMode: "trusted",
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 20);
    const result = await hung;
    expect(result.stopReason).toBe("cancelled");
  });
});

function liveTextOf(update: { notification: { update: { sessionUpdate: string; content?: { type: string; text?: string } } } }): string | undefined {
  const payload = update.notification.update;
  if (payload.sessionUpdate !== "agent_message_chunk") return undefined;
  if (payload.content?.type !== "text") return undefined;
  return payload.content.text;
}
