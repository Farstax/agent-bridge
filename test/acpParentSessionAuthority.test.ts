import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { runAcpTurn, type AcpRetainedEvent, type AcpTurnResult } from "../src/acp/client.js";
import { createCodexAcpAnswerPreview } from "../src/providers/codexAcpAnswerPreview.js";
import { toCliResult } from "../src/providers/codexAcpRuntime.js";

function createForeignSessionAgent(): acp.AgentApp {
  return acp.agent({ name: "foreign-session-test-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "root-session" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "child-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "private child output" },
          _meta: { codex: { phase: "final_answer" } },
        },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "root-session",
        update: { sessionUpdate: "usage_update", used: 12, size: 100_000 },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "child-session",
        update: { sessionUpdate: "usage_update", used: 999, size: 999 },
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: "root-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "parent answer" },
        },
      });
      return { stopReason: "end_turn" };
    });
}

function retainedMessage({
  notificationSessionId,
  rootSessionId = "root-session",
  text,
  phase,
}: {
  notificationSessionId: string;
  rootSessionId?: string;
  text: string;
  phase?: "commentary" | "final_answer";
}): AcpRetainedEvent {
  return {
    kind: "session_update",
    channel: "live",
    acpSessionId: rootSessionId,
    sessionMode: "fresh",
    notification: {
      sessionId: notificationSessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(phase ? { _meta: { codex: { phase } } } : {}),
      },
    } as any,
  };
}

function turnResult(events: AcpRetainedEvent[], liveText: string): AcpTurnResult {
  return {
    conversationId: "conv-1",
    runId: "run-1",
    acpSessionId: "root-session",
    sessionMode: "fresh",
    stopReason: "end_turn",
    liveText,
    events,
    updates: events.map((event) => ({
      channel: event.channel,
      notification: event.notification!,
    })),
    initialize: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} } as any,
  };
}

describe("ACP parent-session answer authority", () => {
  it("retains child events but excludes child text and usage from parent live delivery", async () => {
    const liveChunks: string[] = [];
    const result = await runAcpTurn({
      peer: createForeignSessionAgent(),
      cwd: process.cwd(),
      conversationId: "conv-1",
      runId: "run-1",
      existingAcpSessionId: null,
      prompt: "go",
      executionMode: "trusted",
      onLiveText: (text) => liveChunks.push(text),
    });

    expect(liveChunks.join("")).toBe("parent answer");
    expect(result.liveText).toBe("parent answer");
    expect(result.contextUsage).toEqual({ used: 12, size: 100_000 });
    expect(result.events.some((event) => event.notification?.sessionId === "child-session")).toBe(true);
  });

  it("never previews a child-session final-answer chunk", () => {
    const chunks: string[] = [];
    const preview = createCodexAcpAnswerPreview((text) => chunks.push(text), []);
    preview.observe(retainedMessage({
      notificationSessionId: "child-session",
      text: "private child final",
      phase: "final_answer",
    }));
    preview.observe(retainedMessage({
      notificationSessionId: "root-session",
      text: "parent final",
      phase: "final_answer",
    }));
    preview.finish("end_turn");

    expect(chunks.join("")).toBe("parent final");
    expect(chunks.join("")).not.toContain("child");
  });

  it("ignores child phase semantics and child final text when selecting the parent CliResult", () => {
    const child = retainedMessage({
      notificationSessionId: "child-session",
      text: "private child final",
      phase: "final_answer",
    });
    const parent = retainedMessage({
      notificationSessionId: "root-session",
      text: "parent answer",
    });

    expect(toCliResult(turnResult([child, parent], "parent answer")).text).toBe("parent answer");
  });

  it("does not let a child final satisfy a phase-aware parent turn with no parent final", () => {
    const parentCommentary = retainedMessage({
      notificationSessionId: "root-session",
      text: "parent commentary",
      phase: "commentary",
    });
    const childFinal = retainedMessage({
      notificationSessionId: "child-session",
      text: "private child final",
      phase: "final_answer",
    });

    expect(() => toCliResult(turnResult([parentCommentary, childFinal], ""))).toThrow(/final_answer/);
  });
});
