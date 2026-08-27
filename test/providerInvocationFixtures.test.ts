import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCliInvocation, parseCliResult, isCapacityExhaustedError, setAntigravityModel } from "../src/cli.js";
import { prependWorkspaceContext } from "../src/workspaceContext.js";

function withTempImage(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-fixture-attachment-"));
  const path = join(dir, "a.png");
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #135 Phase 3A — characterization fixtures.
//
// This file locks in buildCliInvocation()/parseCliResult()'s current
// per-provider behaviour across the dimensions the Phase 3 plan calls out
// (invocation snapshots per provider, tool-free flags, attachment/stdin
// contracts, trusted/safe flags, session resume/fresh-session rules, native
// structured output handling, and fallback classification).

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

describe("provider invocation fixtures — codex", () => {
  it("delivers managed repository context to the provider prompt", () => {
    const prompt = managedPrompt();
    const inv = buildCliInvocation({ bot: "codex", prompt, sessionId: null, command: "codex" });
    expect(inv.args.join("\n")).toContain("selected-owner/selected-repo");
  });
  it("fresh session, safe mode, no model — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex" });
    expect(inv.command).toBe("codex");
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", anyPrompt()]);
  });

  it("resumes an existing session when sessionId is set and there are no attachments — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: "sess-1", command: "codex" });
    expect(inv.args).toEqual(["exec", "resume", "sess-1", "--skip-git-repo-check", anyPrompt()]);
  });

  it("forces a fresh session when attachments are present even with a sessionId — exact arg order, stdin carries the prompt", () => {
    const inv = buildCliInvocation({
      bot: "codex", prompt: "hi", sessionId: "sess-1", command: "codex", attachments: ["/tmp/a.png"],
    });
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "-i", "/tmp/a.png", "--", "-"]);
    expect(inv.stdin).toBeTruthy();
  });

  it("trusted mode — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", executionMode: "trusted" });
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", anyPrompt()]);
  });

  it("tool-free mode — exact arg order, full documented Codex tool set, nothing extra", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", toolMode: "none" });
    expect(inv.args).toEqual([
      "exec",
      "--disable", "shell_tool",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "plugins",
      "--disable", "guardian_approval",
      "--disable", "hooks",
      "--disable", "goals",
      "--disable", "apps",
      "--skip-git-repo-check",
      anyPrompt(),
    ]);
  });

  it("json output format — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "codex", prompt: "hi", sessionId: null, command: "codex", outputFormat: "json" });
    expect(inv.args).toEqual(["exec", "--skip-git-repo-check", "--json", anyPrompt()]);
  });
});

describe("provider invocation fixtures — claude", () => {
  it("delivers managed repository context to the provider prompt", () => {
    const prompt = managedPrompt();
    const inv = buildCliInvocation({ bot: "claude", prompt, sessionId: null, command: "claude" });
    expect(inv.args.join("\n")).toContain("selected-owner/selected-repo");
  });
  it("fresh session, safe mode — exact arg order: --print, settings, prompt last", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args[1]).toBe("--settings");
    expect(JSON.parse(inv.args[2])).toEqual({ enabledPlugins: { "telegram@claude-plugins-official": false } });
    expect(inv.args.slice(3)).toEqual([anyPrompt()]);
    expect(inv.stdin).toBeUndefined();
  });

  it("resumes an existing session — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: "sess-9", command: "claude" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args[1]).toBe("--settings");
    expect(inv.args.slice(3)).toEqual(["--resume", "sess-9", anyPrompt()]);
  });

  it("trusted mode — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", executionMode: "trusted" });
    expect(inv.args.slice(3)).toEqual(["--dangerously-skip-permissions", anyPrompt()]);
  });

  it("tool-free mode — exact arg order, strict empty MCP config", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", toolMode: "none" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args.slice(1, 6)).toEqual(["--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config"]);
    expect(inv.args[6]).toBe('{"mcpServers":{}}');
    expect(inv.args[7]).toBe("--settings");
    expect(inv.args.slice(9)).toEqual([anyPrompt()]);
  });

  it("attachments switch to the stream-json stdin contract — exact arg order, no trailing prompt arg", () => {
    withTempImage((path) => {
      const inv = buildCliInvocation({
        bot: "claude", prompt: "hi", sessionId: "sess-1", command: "claude", attachments: [path],
      });
      expect(inv.args[0]).toBe("--settings");
      expect(inv.args.slice(2)).toEqual([
        "--resume", "sess-1", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      ]);
      expect(inv.stdin).toBeTruthy();
    });
  });

  it("json output format — exact arg order (not the stream-json attachment contract)", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", outputFormat: "json" });
    expect(inv.args.slice(3)).toEqual(["--output-format", "json", anyPrompt()]);
  });

  it("stream-json output ignores provider background bookkeeping", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: "sess-9", command: "claude", outputFormat: "stream-json" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args[1]).toBe("--settings");
    expect(inv.args.slice(3)).toEqual([
      "--resume", "sess-9", "--output-format", "stream-json", "--verbose", "--include-partial-messages", anyPrompt(),
    ]);
    expect(inv.stdin).toBeUndefined();

    expect(parseCliResult({
      bot: "claude",
      stdout: [
        '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test","run_in_background":true}}]}}',
        '{"type":"result","subtype":"success","result":"Tests are running.","session_id":"sess-9"}',
      ].join("\n"),
      logContent: null,
    })).toEqual({
      text: "Tests are running.",
      sessionId: "sess-9",
    });
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
  it("codex: extracts sessionId from thread.started and text from response.completed", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "response.completed", output_text: "done" }),
    ].join("\n");
    const result = parseCliResult({ bot: "codex", stdout });
    expect(result.sessionId).toBe("t-1");
    expect(result.text).toBe("done");
  });

  it("codex: malformed structured lines fail closed even with a later final", () => {
    const stdout = "not json\n{\"broken\n" + JSON.stringify({ type: "response.completed", output_text: "ok" });
    expect(() => parseCliResult({ bot: "codex", stdout }))
      .toThrow(/completion could not be verified/i);
  });

  it("claude: parses the last JSON object with a result field", () => {
    const stdout = `noise\n${JSON.stringify({ type: "result", subtype: "success", session_id: "s-1", result: "hello" })}`;
    const result = parseCliResult({ bot: "claude", stdout });
    expect(result.sessionId).toBe("s-1");
    expect(result.text).toBe("hello");
  });

  it("claude: falls back to plain text when no JSON result object is present", () => {
    const result = parseCliResult({ bot: "claude", stdout: "plain response, no JSON here" });
    expect(result.text).toBe("plain response, no JSON here");
    expect(result.sessionId).toBeNull();
  });

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

  it("settings-file preservation: setAntigravityModel only touches the 'model' key, leaving unrelated settings intact", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "agy-settings-preserve-"));
    try {
      const settingsDir = join(tempDir, ".gemini", "antigravity-cli");
      const settingsPath = join(settingsDir, "settings.json");
      mkdirSync(settingsDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ theme: "dark", telemetry: false }));

      setAntigravityModel("gemini-3.5-flash-high", tempDir);
      let data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data).toEqual({ theme: "dark", telemetry: false, model: "Gemini 3.5 Flash (High)" });

      setAntigravityModel(null, tempDir);
      data = JSON.parse(readFileSync(settingsPath, "utf8"));
      expect(data).toEqual({ theme: "dark", telemetry: false });
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
