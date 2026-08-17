import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";

describe("parseCliResult", () => {
  it("parses Codex session and completed agent text", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } }),
    ].join("\n");

    expect(parseCliResult({ bot: "codex", stdout })).toMatchObject({
      sessionId: "thread-1",
      text: "Final answer",
    });
  });

  it("accepts Codex response.completed output text", () => {
    const stdout = JSON.stringify({ type: "response.completed", output_text: "Completed response" });
    expect(parseCliResult({ bot: "codex", stdout }).text).toBe("Completed response");
  });

  it("uses Codex deltas only when no final text event is present", () => {
    const deltas = [
      JSON.stringify({ type: "response.output_text.delta", delta: "Hello " }),
      JSON.stringify({ type: "response.output_text.delta", delta: "world" }),
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout: deltas }).text).toBe("Hello world");

    const withFinal = [
      deltas,
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer" } }),
    ].join("\n");
    expect(parseCliResult({ bot: "codex", stdout: withFinal }).text).toBe("Final answer");
  });

  it("returns an empty Codex result for empty stdout", () => {
    expect(parseCliResult({ bot: "codex", stdout: "" })).toMatchObject({ text: "", sessionId: null });
  });

  it("parses the final Claude result line, session, and trimmed text", () => {
    const stdout = [
      JSON.stringify({ type: "assistant", content: "interim" }),
      JSON.stringify({ type: "result", result: "  Final answer  ", session_id: "session-1" }),
    ].join("\n");

    expect(parseCliResult({ bot: "claude", stdout })).toMatchObject({
      text: "Final answer",
      sessionId: "session-1",
    });
  });

  it("falls back to raw Claude stdout when there is no JSON result", () => {
    expect(parseCliResult({ bot: "claude", stdout: "Plain text response" })).toMatchObject({
      text: "Plain text response",
      sessionId: null,
    });
  });
});
