import { describe, expect, it } from "vitest";
import { parseCliResult } from "../src/cli.js";
import { validateSuccessfulCliExit } from "../src/cliSuccessfulExitValidation.js";

const AGY_SESSION = "11111111-2222-3333-4444-555555555555";

describe("provider uncertain completion contract", () => {
  it("fails closed when Codex exit-zero output is malformed", () => {
    expect(() => parseCliResult({
      bot: "codex",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "codex-session" })}\nnot-json\n`,
    })).toThrow(/Codex structured output/i);
  });

  it("fails closed when Codex has session evidence but no final answer", () => {
    expect(() => parseCliResult({
      bot: "codex",
      stdout: `${JSON.stringify({ type: "thread.started", thread_id: "codex-session" })}\n`,
    })).toThrow(/completion could not be verified/i);
  });

  it("rejects exit-zero Agy output without a terminal result before run.completed", () => {
    const error = validateSuccessfulCliExit("antigravity", {
      stdout: `${JSON.stringify({ event: "init", conversation_id: AGY_SESSION })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("rejects exit-zero Grok output without terminal evidence before run.completed", () => {
    const error = validateSuccessfulCliExit("grok", {
      stdout: `${JSON.stringify({ type: "text", data: "partial answer" })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });

  it("rejects exit-zero Cursor output without a terminal result before run.completed", () => {
    const error = validateSuccessfulCliExit("cursor", {
      stdout: `${JSON.stringify({ type: "assistant", session_id: "cursor-session", message: "internal" })}\n`,
      stderr: "",
    });
    expect(error?.message).toMatch(/completion could not be verified/i);
  });
});
