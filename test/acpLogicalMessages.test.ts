import { describe, expect, it } from "vitest";
import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  ACP_MESSAGE_SEPARATOR,
  createLogicalPreviewTextStream,
  reconstructLogicalMessages,
  renderLogicalMessages,
} from "../src/acp/logicalMessages.js";
import { liveDeliveryText, type AcpObservedUpdate } from "../src/acp/replay.js";

const text = (value: string, messageId?: string, meta?: unknown): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
  ...(messageId ? { messageId } : {}),
  ...(meta ? { _meta: meta } : {}),
} as SessionUpdate);
const tool = (): SessionUpdate => ({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" } as SessionUpdate);
const toolUpdate = (): SessionUpdate => ({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as SessionUpdate);
const thought = (): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } as SessionUpdate);
const render = (updates: SessionUpdate[]) => renderLogicalMessages(reconstructLogicalMessages(updates));

describe("ACP logical message reconstruction", () => {
  it("joins same-id fragments byte-for-byte", () => {
    expect(render([text("Hel", "A"), text("lo", "A"), text(", world.", "A")])).toBe("Hello, world.");
  });

  it("joins id-less fragments byte-for-byte", () => {
    expect(render([text("Hel"), text("lo"), text(", world.")])).toBe("Hello, world.");
  });

  it("starts a new logical message when messageId changes", () => {
    const messages = reconstructLogicalMessages([text("Checked step one.", "A"), text("Step two done.", "B")]);
    expect(messages.map((message) => message.boundaryReason)).toEqual([undefined, "message-id-change"]);
    expect(renderLogicalMessages(messages)).toBe("Checked step one.\n\nStep two done.");
  });

  it("renders exactly one paragraph break between three distinct ids", () => {
    expect(render([text("one ", "A"), text("two", "B"), text(" three\n", "C")])).toBe("one \n\ntwo\n\n three\n");
  });

  it.each([
    ["tool_call", tool()],
    ["tool_call_update", toolUpdate()],
    ["agent_thought_chunk", thought()],
  ])("treats %s between id-less text runs as a boundary", (_name, structural) => {
    const messages = reconstructLogicalMessages([text("before."), structural, text("Step")]);
    expect(messages.map((message) => message.boundaryReason)).toEqual([undefined, "structural-event"]);
    expect(renderLogicalMessages(messages)).toBe("before.\n\nStep");
  });

  it("does not split id-less text without structural evidence, whatever the punctuation", () => {
    expect(render([text("done."), text("Step"), text(" two")])).toBe("done.Step two");
  });

  it("does not treat non-structural events as boundaries", () => {
    const usage = { sessionUpdate: "usage_update", used: 1, size: 2 } as unknown as SessionUpdate;
    const commands = { sessionUpdate: "available_commands_update", availableCommands: [] } as unknown as SessionUpdate;
    expect(render([text("a"), usage, commands, text("b")])).toBe("ab");
  });

  it("keeps one message when a shared messageId spans a tool event", () => {
    expect(render([text("a", "A"), tool(), text("b", "A")])).toBe("ab");
  });

  it("does not split on a first-seen id after id-less text without structural evidence", () => {
    expect(render([text("a"), text("b", "A")])).toBe("ab");
  });

  it("preserves whitespace, newlines and empty fragments inside a message", () => {
    expect(render([text(" lead ", "A"), text("", "A"), text("x\n", "A"), text("\ny", "A"), text("  ", "A")])).toBe(" lead x\n\ny  ");
  });

  it("ignores empty fragments for boundary decisions", () => {
    expect(render([text("a"), tool(), text(""), text("b")])).toBe("a\n\nb");
  });

  it("only ever adds the separator between messages", () => {
    const updates = [text("a", "A"), text("b", "B"), tool(), text("c", "B")];
    const messages = reconstructLogicalMessages(updates);
    expect(renderLogicalMessages(messages)).toBe(messages.map((m) => m.text).join(ACP_MESSAGE_SEPARATOR));
    expect(renderLogicalMessages(messages).replaceAll(ACP_MESSAGE_SEPARATOR, "")).toBe("abc");
  });

  it("treats a caller-supplied group change as a boundary", () => {
    const meta = (phase: string) => ({ codex: { phase } });
    const messages = reconstructLogicalMessages(
      [text("x", undefined, meta("commentary")), text("y", undefined, meta("final_answer"))],
      { groupOf: (update) => (update as { _meta?: { codex?: { phase?: string } } })._meta?.codex?.phase },
    );
    expect(messages.map((message) => message.boundaryReason)).toEqual([undefined, "group-change"]);
  });
});

describe("live preview parity", () => {
  const preview = (updates: SessionUpdate[]) => {
    const next = createLogicalPreviewTextStream();
    return updates.map((update) => next(update)).join("");
  };
  const sequences: Record<string, SessionUpdate[]> = {
    "id-less fragments": [text("Hel"), text("lo"), text(", world.")],
    "id change": [text("Checked.", "A"), text("Next.", "B")],
    "tool separated": [text("before."), tool(), text("after."), thought(), text("last.")],
    "mixed whitespace": [text("a\n"), tool(), text("\nb")],
  };
  for (const [name, updates] of Object.entries(sequences)) {
    it(`matches terminal rendering: ${name}`, () => {
      expect(preview(updates)).toBe(render(updates));
    });
  }

  it("matches replay reconstruction and excludes replay-channel and child-session updates", () => {
    const observed = (channel: "live" | "replay", sessionId: string, update: SessionUpdate): AcpObservedUpdate => ({
      channel,
      notification: { sessionId, update } as SessionNotification,
    });
    const updates = [
      observed("replay", "root", text("old history.")),
      observed("live", "root", text("before.")),
      observed("live", "child", tool()),
      observed("live", "child", text("child text")),
      observed("live", "root", text("still same message")),
      observed("live", "root", tool()),
      observed("live", "root", text("after.")),
    ];
    expect(liveDeliveryText(updates, "root")).toBe("before.still same message\n\nafter.");
  });

  it("suppresses hidden groups from preview but keeps their boundary evidence", () => {
    const group = (update: SessionUpdate) => (update as { _meta?: { g?: string } })._meta?.g;
    const next = createLogicalPreviewTextStream({ groupOf: group, accept: (fragment) => fragment.group === "final" });
    const out = [
      next(text("plan", undefined, { g: "note" })),
      next(text("one", undefined, { g: "final" })),
      next(text("note", undefined, { g: "note" })),
      next(text("two", undefined, { g: "final" })),
    ].join("");
    expect(out).toBe("one\n\ntwo");
  });
});
