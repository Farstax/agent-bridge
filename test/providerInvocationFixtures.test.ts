import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, parseCliResult, isCapacityExhaustedError } from "../src/cli.js";
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

describe("provider invocation fixtures — antigravity ACP", () => {
  it("always selects the release-locked ACP transport instead of native Agy argv", () => {
    const prompt = managedPrompt();
    const fresh = buildCliInvocation({
      bot: "antigravity",
      prompt,
      sessionId: null,
      command: "agy_acp_server.par",
      executionMode: "safe",
      toolMode: "none",
    });
    expect(fresh).toMatchObject({
      command: expect.stringMatching(/agy_acp_server\.par$/) as unknown as string,
      args: ["--uid="],
      nativeSessionMode: "fresh",
      transport: "acp-stdio",
    });
    expect(fresh.prompt).toContain("selected-owner/selected-repo");
    expect(fresh.args).not.toContain("--print");
    expect(fresh.args).not.toContain("--sandbox");

    const resumed = buildCliInvocation({
      bot: "antigravity",
      prompt: "hi",
      sessionId: "sess-9",
      command: "agy_acp_server.par",
      executionMode: "trusted",
    });
    expect(resumed).toMatchObject({
      args: ["--uid="],
      nativeSessionMode: "resume",
      transport: "acp-stdio",
    });
    expect(resumed.args).not.toContain("--conversation");
    expect(resumed.args).not.toContain("--dangerously-skip-permissions");
  });

  it("refuses native Agy output parsing because ACP returns structured results", () => {
    expect(() => parseCliResult({ bot: "antigravity", stdout: "plain response" }))
      .toThrow(/ACP structured results/);
  });
});

describe("provider result parsing fixtures", () => {
  it("unknown bot type throws", () => {
    expect(() => parseCliResult({ bot: "unknown-bot", stdout: "x" })).toThrow(/Unknown bot type/);
  });
});

describe("provider result parsing fixtures — antigravity", () => {
  it("refuses native stream-json parsing after ACP migration", () => {
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        event: "result",
        result: { conversation_id: "c107dfbd-181e-4cf0-a840-894662adee43", status: "SUCCESS", response: "The answer." },
      }),
    })).toThrow(/ACP structured results/);
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
