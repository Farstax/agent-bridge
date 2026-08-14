import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAnswerPresentationDecoder } from "../src/providers/claudeAnswerPresentation.js";

const textDelta = (text: string) => JSON.stringify({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  },
});

describe("Claude answer presentation decoder", () => {
  it("decodes the sanitized live fresh and resumed fixtures", () => {
    for (const fixture of ["claude-2.1.231-fresh.jsonl", "claude-2.1.231-resumed.jsonl"]) {
      const deltas: string[] = [];
      const decoder = createClaudeAnswerPresentationDecoder((delta) => deltas.push(delta));
      decoder.push(readFileSync(join(process.cwd(), "test/fixtures/issue388", fixture), "utf8"));
      decoder.finish();
      expect(decoder.enabled).toBe(true);
      expect(deltas.join("")).toMatch(/CLAUDE_/);
    }
  });

  it("emits only text deltas and handles JSONL records split across chunks", () => {
    const deltas: string[] = [];
    const decoder = createClaudeAnswerPresentationDecoder((delta) => deltas.push(delta));
    const record = textDelta("safe answer");

    decoder.push(record.slice(0, 19));
    decoder.push(`${record.slice(19)}\n`);
    decoder.finish();

    expect(deltas).toEqual(["safe answer"]);
    expect(decoder.enabled).toBe(true);
  });

  it("ignores thinking, tools, system, terminal, and unknown events", () => {
    const deltas: string[] = [];
    const decoder = createClaudeAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push([
      JSON.stringify({ type: "system", subtype: "status", status: "requesting" }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "secret" } }] } }),
      JSON.stringify({ type: "provider.future_event", answer: "must not leak" }),
      JSON.stringify({ type: "result", result: "terminal answer" }),
    ].join("\n") + "\n");

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(false);
  });

  it("disables preview on malformed complete JSON and ignores later records", () => {
    const deltas: string[] = [];
    const decoder = createClaudeAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push("{malformed}\n");
    decoder.push(`${textDelta("must not leak")}\n`);
    decoder.finish();

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(false);
  });

  it("does not treat an unterminated partial record as answer text", () => {
    const deltas: string[] = [];
    const decoder = createClaudeAnswerPresentationDecoder((delta) => deltas.push(delta));
    decoder.push(textDelta("partial"));
    decoder.finish();

    expect(deltas).toEqual([]);
    expect(decoder.enabled).toBe(true);
  });
});
