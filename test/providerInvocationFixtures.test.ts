import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, parseCliResult, isCapacityExhaustedError, setAntigravityModel } from "../src/cli.js";
import { prependWorkspaceContext } from "../src/workspaceContext.js";

// Issue #135 Phase 3A — characterization fixtures.
//
// This file locks in buildCliInvocation()/parseCliResult()'s current
// per-provider behaviour. ACP-backed providers are characterized at the
// transport boundary here; protocol/session policy lives in their ACP suites.

// Wrapped prompts embed the full soul contract + Telegram response-style
// block, which is itself characterized elsewhere — matched positionally here
// with expect.stringContaining() rather than reproduced verbatim, so these
// stay exact on flag identity, order, and count without being brittle against
// unrelated prompt-wrapping copy changes.
const anyPrompt = () => expect.stringContaining("hi") as unknown as string;

function managedPrompt(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-workspace-context-"));
  const file = join(dir, "workspace-context.md");
  writeFileSync(file, "Repository: selected-owner/selected-repo\nDefault branch: main\n");
  const prompt = prependWorkspaceContext("hi", { AGENT_BRIDGE_WORKSPACE_CONTEXT_FILE: file });
  rmSync(dir, { recursive: true, force: true });
  return prompt;
}

describe("provider invocation fixtures — claude ACP", () => {
  it("always selects the release-locked ACP transport instead of native Claude argv", () => {
    const fresh = buildCliInvocation({
      bot: "claude",
      prompt: managedPrompt(),
      sessionId: null,
      command: "claude",
      executionMode: "safe",
      toolMode: "none",
    });
    expect(fresh).toMatchObject({
      command: expect.stringContaining("node_modules/.bin/claude-agent-acp") as unknown as string,
      args: [],
      nativeSessionMode: "fresh",
      transport: "acp-stdio",
    });
    expect(fresh.stdin).toBeUndefined();
    expect(fresh.args).not.toContain("--print");
    expect(fresh.args).not.toContain("--dangerously-skip-permissions");

    const resumed = buildCliInvocation({
      bot: "claude",
      prompt: "hi",
      sessionId: "sess-9",
      command: "claude",
      executionMode: "trusted",
    });
    expect(resumed).toMatchObject({
      command: expect.stringContaining("node_modules/.bin/claude-agent-acp") as unknown as string,
      args: [],
      nativeSessionMode: "resume",
      transport: "acp-stdio",
    });
    expect(resumed.args).not.toContain("--resume");
  });

  it("refuses native Claude output parsing because ACP returns structured results", () => {
    expect(() => parseCliResult({ bot: "claude", stdout: "plain response" }))
      .toThrow(/ACP structured results/);
  });
});

describe("provider invocation fixtures — antigravity", () => {
  it("delivers managed repository context to the provider prompt", () => {
    const prompt = managedPrompt();
    const inv = buildCliInvocation({ bot: "antigravity", prompt, sessionId: null, command: "agy" });
    expect(inv.args.join("\n")).toContain("selected-owner/selected-repo");
  });

  it("fresh session — exact stream-json arg order", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy" });
    expect(inv.args).toEqual(["--output-format", "stream-json", "--print", anyPrompt()]);
  });

  it("resumes an existing conversation — exact stream-json arg order", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: "conv-1", command: "agy" });
    expect(inv.args).toEqual([
      "--conversation", "conv-1", "--output-format", "stream-json", "--print", anyPrompt(),
    ]);
  });

  it("trusted mode — exact stream-json arg order", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", executionMode: "trusted" });
    expect(inv.args).toEqual([
      "--dangerously-skip-permissions", "--output-format", "stream-json", "--print", anyPrompt(),
    ]);
  });

  it("tool-free mode — exact stream-json arg order, --sandbox present", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", toolMode: "none" });
    expect(inv.args).toEqual(["--sandbox", "--output-format", "stream-json", "--print", anyPrompt()]);
  });

  it("attachments are annotated inline into the prompt text, not passed as separate flags", () => {
    const inv = buildCliInvocation({
      bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", attachments: ["/tmp/a.png"],
    });
    expect(inv.args).toHaveLength(4);
    expect(inv.args.slice(0, 3)).toEqual(["--output-format", "stream-json", "--print"]);
    expect(inv.args[inv.args.length - 1]).toContain("/tmp/a.png");
    expect(inv.stdin).toBeUndefined();
  });
});

describe("provider result parsing fixtures", () => {
  it("unknown bot type throws", () => {
    expect(() => parseCliResult({ bot: "unknown-bot", stdout: "x" })).toThrow(/Unknown bot type/);
  });
});

describe("provider result parsing fixtures — antigravity", () => {
  const sessionId = "c107dfbd-181e-4cf0-a840-894662adee43";

  it("uses the stream-json terminal response and native session id", () => {
    const stdout = [
      JSON.stringify({ event: "init", conversation_id: sessionId }),
      JSON.stringify({ event: "result", result: { conversation_id: sessionId, status: "SUCCESS", response: "The answer." } }),
    ].join("\n");
    expect(parseCliResult({ bot: "antigravity", stdout })).toEqual({
      text: "The answer.",
      sessionId,
    });
  });

  it("timeout: terminal stream-json ERROR throws a timeout error", () => {
    const stdout = JSON.stringify({
      event: "result",
      result: { conversation_id: sessionId, status: "ERROR", response: "", error: "timeout waiting for response" },
    });
    expect(() => parseCliResult({ bot: "antigravity", stdout })).toThrow(/timed out/i);
  });

  it("settings-file preservation: setAntigravityModel only touches the managed 'model' and 'verbosity' keys, leaving unrelated settings intact", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agy-settings-preserve-"));
    try {
      const settingsDir = join(tempDir, ".gemini", "antigravity-cli");
      const settingsPath = join(settingsDir, "settings.json");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ theme: "dark", telemetry: false }));

      setAntigravityModel("gemini-3.5-flash-high", tempDir);
      let data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data).toEqual({ theme: "dark", telemetry: false, model: "Gemini 3.5 Flash (High)", verbosity: "compact" });

      setAntigravityModel(null, tempDir);
      data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data).toEqual({ theme: "dark", telemetry: false, verbosity: "compact" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("provider failure fallback classification fixtures", () => {
  it("codex capacity exhaustion is fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error("CLI exited with code 1: MODEL_CAPACITY_EXHAUSTED"))).toBe(true);
  });

  it("claude rate-limit style errors are fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error(
      `CLI exited with code 1: ${JSON.stringify({ type: "result", is_error: true, api_error_status: 429, result: "rate limited" })}`,
    ))).toBe(true);
  });

  it("a generic non-capacity CLI failure is not fallback-eligible", () => {
    expect(isCapacityExhaustedError(new Error("CLI exited with code 1: command not found: unsupported-provider"))).toBe(false);
  });
});
