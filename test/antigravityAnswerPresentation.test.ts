import { describe, expect, it } from "vitest";
import { createAntigravityAnswerPresentationDecoder } from "../src/providers/antigravityAnswerPresentation.js";

const textDelta = (text: string) => JSON.stringify({
  event: "step_update",
  step_update: {
    conversation_id: "test-id",
    step_index: 2,
    state: "DONE",
    step_type: "agent_response",
    text_delta: text,
  },
});

describe("Antigravity answer presentation decoder", () => {
  it("emits only agent response text deltas and handles JSONL records split across chunks", () => {
    const deltas: string[] = [];
    const decoder = createAntigravityAnswerPresentationDecoder((delta) => deltas.push(delta));
    const record = textDelta("safe answer");

    decoder.push(record.slice(0, 19));
    decoder.push(`${record.slice(19)}\n`);
    decoder.finish();

    expect(deltas).toEqual(["safe answer"]);
    expect(decoder.enabled).toBe(true);
  });

  it("ignores user_input, checkpoint, tool, and unknown events", () => {
    const deltas: string[] = [];
    const decoder = createAntigravityAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push([
      JSON.stringify({ event: "init", conversation_id: "test-id", init: { cwd: "/", tools: [], permission_mode: "always-proceed" } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "test-id", step_index: 0, state: "DONE", step_type: "user_input" } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "test-id", step_index: 1, state: "DONE", step_type: "checkpoint" } }),
      JSON.stringify({ event: "step_update", step_update: { conversation_id: "test-id", step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command" } }),
      JSON.stringify({ event: "result", result: { conversation_id: "test-id", status: "SUCCESS", response: "terminal answer" } }),
    ].join("\n") + "\n");

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(true); // these are known events, so decoder remains enabled
  });

  it("disables preview on malformed complete JSON and ignores later records", () => {
    const deltas: string[] = [];
    const decoder = createAntigravityAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push("{malformed}\n");
    decoder.push(`${textDelta("must not leak")}\n`);
    decoder.finish();

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(false);
  });

  it("disables preview on unknown events to fail closed", () => {
    const deltas: string[] = [];
    const decoder = createAntigravityAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push(JSON.stringify({ event: "future_unsupported_event", data: {} }) + "\n");
    decoder.push(`${textDelta("must not leak")}\n`);
    decoder.finish();

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(false);
  });

  it("does not treat an unterminated partial record as answer text", () => {
    const deltas: string[] = [];
    const decoder = createAntigravityAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push(textDelta("partial"));
    decoder.finish();

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(true);
  });
});
