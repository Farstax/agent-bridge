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

  it("does not emit replayed history through onLiveText used by Telegram/Discord progress", async () => {
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
    const liveChunks: string[] = [];
    const second = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: first.acpSessionId,
      prompt: "second",
      executionMode: "trusted",
      onLiveText: (text) => liveChunks.push(text),
    });
    expect(liveChunks.join("")).toBe("live:second");
    expect(liveChunks.join("")).not.toContain("first");
    expect(second.liveText).toBe("live:second");
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
    expect(second.liveText).toBe("live:second");
    expect(second.liveText).not.toContain("first");
  });

  it("does not close a durable ACP session after a successful prompt", async () => {
    let closed = 0;
    const agent = createFakeAcpAgent({
      loadSession: true,
      resume: true,
      close: true,
      onClose: () => { closed += 1; },
    });
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
    expect(closed).toBe(0);
    expect(second.sessionMode).toBe("resume");
    expect(second.liveText).toBe("live:second");
  });

  it("treats session/resume as a live continuation, per ACP v1: resume does not replay history", async () => {
    const agent = createFakeAcpAgent({ loadSession: false, resume: true });
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
    // No replay channel exists for resume — every observed update is live.
    expect(second.updates.every((update) => update.channel === "live")).toBe(true);
    expect(second.liveText).toBe("live:second");
    expect(second.liveText).not.toContain("first");
  });

  it("fails closed when an existing ACP session cannot be resumed or loaded", async () => {
    await expect(runAcpTurn({
      peer: createFakeAcpAgent({ loadSession: false, resume: false }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: "acp-existing-1",
      prompt: "second",
      executionMode: "trusted",
    })).rejects.toThrow(/does not support resume or load/i);
  });

  it("fails closed on a malformed initialize response", async () => {
    await expect(runAcpTurn({
      peer: createFakeAcpAgent({ initializeError: new Error("initialize exploded") }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "trusted",
    })).rejects.toThrow();
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
    const trustedPermission = trusted.events.find((event) => event.kind === "permission");
    expect(trustedPermission?.permissionRequest?.toolCall.kind).toBe("edit");
    expect(trustedPermission?.permissionResponse?.outcome.outcome).toBe("selected");

    const safe = await runAcpTurn({
      peer: createFakeAcpAgent({ permissionOn: "PERM" }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: null,
      prompt: "PERM please",
      executionMode: "safe",
    });
    const safePermission = safe.events.find((event) => event.kind === "permission");
    expect(safePermission?.permissionRequest?.toolCall.kind).toBe("edit");
    expect(safePermission?.permissionResponse?.outcome).toEqual({ outcome: "selected", optionId: "reject" });
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

  it("takes turn consumption from PromptResponse.usage and keeps context usage separate", async () => {
    const result = await runAcpTurn({
      peer: createFakeAcpAgent(),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "trusted",
    });
    expect(result.usage).toEqual({ totalTokens: 12, inputTokens: 4, outputTokens: 8, thoughtTokens: 1 });
    expect(result.contextUsage).toEqual({ used: 12, size: 100_000 });
  });

  it("leaves turn consumption unknown when the agent supplies only usage_update", async () => {
    const result = await runAcpTurn({
      peer: createFakeAcpAgent({ usageUpdateOnly: true }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "hello",
      executionMode: "trusted",
    });
    expect(result.usage).toBeUndefined();
    expect(result.contextUsage).toEqual({ used: 12, size: 100_000 });
  });

  it("delivers retained events incrementally through onEvent, tagged with the ACP session as soon as it is known", async () => {
    const agent = createFakeAcpAgent({ loadSession: true, resume: false, close: true });
    const observedLive: Array<{ kind: string; acpSessionId?: string; sessionMode?: string }> = [];
    const first = await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "first",
      executionMode: "trusted",
      onEvent: (event) => observedLive.push(event),
    });
    // Delivered as each protocol message arrives, not batched at the end.
    expect(observedLive.length).toBeGreaterThan(1);
    for (const event of observedLive) {
      expect(event.acpSessionId).toBe(first.acpSessionId);
      expect(event.sessionMode).toBe("fresh");
    }

    const observedReplay: Array<{ channel: string; acpSessionId?: string; sessionMode?: string }> = [];
    await runAcpTurn({
      peer: agent,
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-2",
      existingAcpSessionId: first.acpSessionId,
      prompt: "second",
      executionMode: "trusted",
      onEvent: (event) => observedReplay.push(event),
    });
    // Session id/mode are known even for events fired during session/load replay, before the prompt call.
    const replayed = observedReplay.filter((e) => e.channel === "replay");
    expect(replayed.length).toBeGreaterThan(0);
    for (const event of observedReplay) {
      expect(event.acpSessionId).toBe(first.acpSessionId);
      expect(event.sessionMode).toBe("load");
    }
  });

  it("dispatches an image prompt block when the agent negotiates image support", async () => {
    const result = await runAcpTurn({
      peer: createFakeAcpAgent({ promptCapabilities: { image: true } }),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: [
        { type: "text", text: "look at this" },
        { type: "image", data: "base64data", mimeType: "image/png", uri: "file:///tmp/a.png" },
      ],
      executionMode: "trusted",
    });
    expect(result.stopReason).toBe("end_turn");
  });

  it("fails closed before dispatch when an image prompt block is not negotiated", async () => {
    await expect(runAcpTurn({
      peer: createFakeAcpAgent(),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: [
        { type: "text", text: "look at this" },
        { type: "image", data: "base64data", mimeType: "image/png", uri: "file:///tmp/a.png" },
      ],
      executionMode: "trusted",
    })).rejects.toThrow(/does not support prompt content block type "image"/);
  });

  it("keeps working for a text-only agent that negotiates no optional prompt capabilities", async () => {
    const result = await runAcpTurn({
      peer: createFakeAcpAgent(),
      cwd: process.cwd(),
      conversationId: "conv-bridge-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "plain text only",
      executionMode: "trusted",
    });
    expect(result.stopReason).toBe("end_turn");
    expect(result.liveText).toBe("live:plain text only");
  });
});

function liveTextOf(update: { notification: { update: { sessionUpdate: string; content?: { type: string; text?: string } } } }): string | undefined {
  const payload = update.notification.update;
  if (payload.sessionUpdate !== "agent_message_chunk") return undefined;
  if (payload.content?.type !== "text") return undefined;
  return payload.content.text;
}
