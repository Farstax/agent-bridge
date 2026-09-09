import { describe, expect, it } from "vitest";
import { toCliResult } from "../src/providers/codexAcpRuntime.js";

function fixture({
  updateMeta,
  notificationMeta,
  text = "commentary that must not be promoted",
}: {
  updateMeta?: unknown;
  notificationMeta?: unknown;
  text?: string;
}): Parameters<typeof toCliResult>[0] {
  return {
    conversationId: "conv-malformed-phase",
    runId: "run-malformed-phase",
    acpSessionId: "acp-malformed-phase",
    sessionMode: "fresh",
    stopReason: "end_turn",
    liveText: text,
    events: [],
    updates: [{
      channel: "live",
      notification: {
        sessionId: "acp-malformed-phase",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          ...(updateMeta !== undefined ? { _meta: updateMeta } : {}),
        },
        ...(notificationMeta !== undefined ? { _meta: notificationMeta } : {}),
      },
    }],
    initialize: { protocolVersion: 1, agentCapabilities: {} },
  } as any;
}

describe("Codex ACP malformed phase markers", () => {
  it("fails closed when update._meta.codex is a malformed scalar", () => {
    expect(() => toCliResult(fixture({
      updateMeta: { codex: "malformed" },
    }))).toThrow(/final_answer/);
  });

  it("fails closed when update._meta.codex is explicitly null", () => {
    expect(() => toCliResult(fixture({
      updateMeta: { codex: null },
    }))).toThrow(/final_answer/);
  });

  it("fails closed when Codex phase metadata is misplaced on the notification envelope", () => {
    expect(() => toCliResult(fixture({
      notificationMeta: { codex: { phase: "commentary" } },
    }))).toThrow(/final_answer/);
  });
});
