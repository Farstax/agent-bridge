import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import type { AcpTurnResult } from "../src/acp/client.js";
import type { AcpObservedUpdate } from "../src/acp/replay.js";
import {
  assertQualificationTraceOmits,
  buildLogicalMessageQualificationTrace,
  LogicalMessageQualificationLeak,
} from "../src/acp/logicalMessageQualification.js";

const SECRET = "SUPER_SECRET_CONVERSATION_TEXT";
const TOOL_SECRET = "TOOL_ARGUMENT_SECRET_VALUE";
const MESSAGE_SECRET = "SECRET_MESSAGE_IDENTIFIER";

function text(value: string, messageId?: string, meta?: unknown): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: value },
    ...(messageId ? { messageId } : {}),
    ...(meta ? { _meta: meta } : {}),
  } as SessionUpdate;
}

function observed(update: SessionUpdate, sessionId = "root-session", channel: "live" | "replay" = "live"): AcpObservedUpdate {
  return { channel, notification: { sessionId, update } as AcpObservedUpdate["notification"] };
}

function turn(updates: readonly AcpObservedUpdate[], stopReason = "end_turn"): Pick<AcpTurnResult, "updates" | "acpSessionId" | "stopReason" | "sessionMode"> {
  return { updates, acpSessionId: "root-session", stopReason: stopReason as AcpTurnResult["stopReason"], sessionMode: "fresh" };
}

describe("logical message qualification trace", () => {
  it("records reconstruction, parity, and terminal state without answer text", () => {
    const trace = buildLogicalMessageQualificationTrace("claude", turn([
      observed(text("Checked step one.", "A")),
      observed(text("Step two done.", "B")),
    ]));
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("Checked step one.");
    expect(serialized).not.toContain("Step two done.");
    expect(serialized).not.toContain("root-session");
    expect(trace.previewFinalParity).toBe(true);
    expect(trace.streamIntact).toBe(true);
    expect(trace.messages.map((message) => message.boundaryReason)).toEqual([undefined, "message-id-change"]);
    expect(trace.messages.map((message) => message.charCount)).toEqual(["Checked step one.".length, "Step two done.".length]);
    expect(trace.messages.every((message) => message.selected)).toBe(true);
    expect(trace.terminal).toEqual({ observed: true, stopReason: "end_turn" });
    expect(trace.cleanup).toEqual({ contentRetained: false, durableTrace: false });
    expect(trace.categories.answer).toBe(2);
    assertQualificationTraceOmits(trace, [SECRET, "Checked step one. extra"]);
  });

  it("separates thoughts and tools and drops their payloads", () => {
    const trace = buildLogicalMessageQualificationTrace("grok", turn([
      observed(text("before.", undefined)),
      observed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: SECRET } } as SessionUpdate),
      observed({ sessionUpdate: "tool_call", toolCallId: "t1", title: TOOL_SECRET, rawInput: { token: TOOL_SECRET }, status: "pending" } as SessionUpdate),
      observed(text("after.")),
    ]));
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(TOOL_SECRET);
    expect(serialized).not.toContain("before.");
    expect(trace.categories).toMatchObject({ answer: 2, thought: 1, tool: 1 });
    expect(trace.messages.map((message) => message.boundaryReason)).toEqual([undefined, "structural-event"]);
    expect(trace.previewFinalParity).toBe(true);
    expect(trace.streamIntact).toBe(true);
  });

  it("selects only the final answer when Codex phase semantics are present", () => {
    const commentary = `commentary ${SECRET}`;
    const finalAnswer = `final ${SECRET}`;
    const trace = buildLogicalMessageQualificationTrace("codex", turn([
      observed(text(commentary, "c1", { codex: { phase: "commentary" } })),
      observed(text(finalAnswer, "f1", { codex: { phase: "final_answer" } })),
    ]));
    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(trace.phaseAware).toBe(true);
    expect(trace.messages.map((message) => message.phase)).toEqual(["commentary", "final_answer"]);
    expect(trace.messages.map((message) => message.selected)).toEqual([false, true]);
    expect(trace.finalCharCount).toBe(finalAnswer.length);
    expect(trace.previewFinalParity).toBe(true);
    expect(trace.previewCharCount).not.toBe(commentary.length + 2 + finalAnswer.length);
  });

  it("ignores replay and child-session text when measuring the root answer", () => {
    const trace = buildLogicalMessageQualificationTrace("agy", turn([
      observed(text("replay history that must not count"), "root-session", "replay"),
      observed(text("child output that must not count"), "child-session"),
      observed(text("visible")),
    ]));
    expect(JSON.stringify(trace)).not.toContain("replay history");
    expect(JSON.stringify(trace)).not.toContain("child output");
    expect(trace.finalCharCount).toBe("visible".length);
    expect(trace.previewFinalParity).toBe(true);
    expect(trace.events.filter((event) => !event.sameRootSession)).toHaveLength(1);
    expect(trace.events.some((event) => event.channel === "replay")).toBe(true);
  });

  it("aliases message identifiers and classifies unexpected event names", () => {
    const trace = buildLogicalMessageQualificationTrace("claude", turn([
      observed(text("ok", MESSAGE_SECRET)),
      observed({ sessionUpdate: SECRET } as SessionUpdate),
    ], "not-a-real-stop"));
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain(MESSAGE_SECRET);
    expect(serialized).not.toContain(SECRET);
    expect(trace.messages[0]?.messageIdAlias).toBe("<message-1>");
    expect(trace.events[1]?.sessionUpdate).toBe("unclassified");
    expect(trace.terminal.stopReason).toBe("unclassified");
  });

  it("rejects a provider outside the closed set", () => {
    expect(() => buildLogicalMessageQualificationTrace("other", turn([]))).toThrow(LogicalMessageQualificationLeak);
  });
});
