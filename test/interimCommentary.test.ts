import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk/unstable";
import { createInterimCommentary, INTERIM_COMMENTARY_MAX_CHARS, type InterimCommentarySignal } from "../src/acp/interimCommentary.js";

const text = (value: string, meta?: Record<string, unknown>, messageId?: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: value },
  ...(meta ? { _meta: meta } : {}),
  ...(messageId ? { messageId } : {}),
} as SessionUpdate);
const tool = (id: string): SessionUpdate => ({ sessionUpdate: "tool_call", toolCallId: id, title: "Run `cat .env`", kind: "execute", status: "in_progress" } as SessionUpdate);
const toolUpdate = (id: string): SessionUpdate => ({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" } as SessionUpdate);
const thought = (value: string): SessionUpdate => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: value } } as SessionUpdate);

function harness(secrets: string[] = []) {
  const signals: InterimCommentarySignal[] = [];
  const commentary = createInterimCommentary((signal) => signals.push(signal), secrets);
  return { commentary, signals, texts: () => signals.flatMap((signal) => "text" in signal ? [signal.text] : []) };
}

describe("interim commentary eligibility (protocol evidence only)", () => {
  it("emits a completed message that a following tool call proves was not the final answer", () => {
    const { commentary, texts } = harness();
    commentary.observe(text("Checking the focused suites now."));
    expect(texts()).toEqual([]); // not complete until the turn continues
    commentary.observe(tool("t1"));
    expect(texts()).toEqual(["Checking the focused suites now."]);
  });

  it("never emits the last message of a turn, thoughts, tool titles or tool output", () => {
    const { commentary, signals } = harness();
    commentary.observe(thought("private reasoning about secrets"));
    commentary.observe(tool("t1"));
    commentary.observe(toolUpdate("t1"));
    commentary.observe(text("Here is the final answer."));
    expect(signals).toEqual([]);
  });

  it("treats explicit Codex commentary as commentary and final_answer as never eligible", () => {
    const { commentary, texts } = harness();
    commentary.observe(text("Reading the router.", { codex: { phase: "commentary" } }));
    commentary.observe(text("All done.", { codex: { phase: "final_answer" } }));
    expect(texts()).toEqual(["Reading the router."]);
    commentary.observe(tool("t1"));
    expect(texts()).toEqual(["Reading the router."]); // final_answer text stays private even before a tool call
  });

  it("does not treat an id-less message followed only by another message as commentary", () => {
    const { commentary, signals } = harness();
    commentary.observe(text("First part.", undefined, "m1"));
    commentary.observe(text("Second part.", undefined, "m2"));
    expect(signals).toEqual([]);
  });

  it("assigns each message one stable id and never emits it twice", () => {
    const { commentary, signals } = harness();
    commentary.observe(text("One."));
    commentary.observe(tool("t1"));
    commentary.observe(tool("t2"));
    commentary.observe(text("Two."));
    commentary.observe(tool("t3"));
    expect(signals).toEqual([{ id: "1", text: "One." }, { id: "2", text: "Two." }]);
  });
});

describe("interim commentary safety and bounds", () => {
  const emitsNothing = (value: string, secrets: string[] = []) => {
    const { commentary, signals } = harness(secrets);
    commentary.observe(text(value));
    commentary.observe(tool("t1"));
    expect(signals).toEqual([]);
  };

  it.each([
    ["exact configured secret", "Using key sk-live-ABCDEF0123456789 to call the API.", ["sk-live-ABCDEF0123456789"]],
    ["provider-style key", "Calling with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA now.", []],
    ["GitHub token", "Pushing with ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.", []],
    ["bearer header", "Sending Authorization: Bearer abcdef0123456789abcdef0123456789.", []],
    ["assignment", "Setting API_KEY=supersecretvalue123 in the shell.", []],
    ["password assignment", "Logging in with password: hunter2hunter2", []],
    ["URL credentials", "Cloning https://user:pass1234@github.com/org/repo.git first.", []],
    ["private key block", "-----BEGIN OPENSSH PRIVATE KEY----- then continuing", []],
    ["JWT", "Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl was minted.", []],
    ["long opaque token", "Using 0123456789abcdef0123456789abcdef0123456789abcdef as the value.", []],
    ["fenced code", "Running this:\n```\nrm -rf /\n```", []],
  ])("fails closed for %s", (_name, value, secrets) => emitsNothing(value, secrets));

  it("collapses whitespace to a single line and bounds length with an ellipsis", () => {
    const { commentary, texts } = harness();
    commentary.observe(text("  Looking   at\n\nthe   result.  "));
    commentary.observe(tool("t1"));
    commentary.observe(text(`${"word ".repeat(200)}end`));
    commentary.observe(tool("t2"));
    const [first, second] = texts();
    expect(first).toBe("Looking at the result.");
    expect(second!.length).toBeLessThanOrEqual(INTERIM_COMMENTARY_MAX_CHARS);
    expect(second!.endsWith("…")).toBe(true);
  });

  it("caps emissions per attempt", () => {
    const { commentary, texts } = harness();
    for (let index = 0; index < 40; index += 1) {
      commentary.observe(text(`Step ${index}.`));
      commentary.observe(tool(`t${index}`));
    }
    expect(texts()).toHaveLength(12);
  });

  it("ignores empty and whitespace-only messages", () => {
    const { commentary, signals } = harness();
    commentary.observe(text("   "));
    commentary.observe(tool("t1"));
    expect(signals).toEqual([]);
  });
});

describe("interim commentary reset", () => {
  it("emits a clear only when something was shown, and restarts ids and the cap", () => {
    const { commentary, signals } = harness();
    commentary.reset();
    expect(signals).toEqual([]);
    commentary.observe(text("Before retry."));
    commentary.observe(tool("t1"));
    commentary.reset();
    commentary.observe(text("After retry."));
    commentary.observe(tool("t2"));
    expect(signals).toEqual([{ id: "1", text: "Before retry." }, { clear: 1 }, { id: "1", text: "After retry." }]);
  });
});
