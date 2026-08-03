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
// (invocation snapshots per provider/mode, tool-free flags, attachment/stdin
// contracts, trusted/safe flags, session resume/fresh-session rules, stream-
// json handling, malformed/legacy output parsing, and fallback
// classification) BEFORE any provider branch is moved out of src/cli.ts in
// PR 3B/3C. A behavioural difference introduced by that later move must show
// up here first.

// Wrapped prompts embed the full soul contract + Telegram response-style
// block, which is itself characterized elsewhere (wrapAntigravityPrompt /
// wrapTelegramPrompt tests in test/cli.test.ts) — matched positionally here
// with expect.stringContaining() rather than reproduced verbatim, so these
// stay exact on flag identity, order, and count (catching a duplicated flag,
// reordering, or an unexpected extra argument) without being brittle against
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
        "--resume", "sess-1", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      ]);
      expect(inv.stdin).toBeTruthy();
    });
  });

  it("json output format — exact arg order (not the stream-json attachment contract)", () => {
    const inv = buildCliInvocation({ bot: "claude", prompt: "hi", sessionId: null, command: "claude", outputFormat: "json" });
    expect(inv.args.slice(3)).toEqual(["--output-format", "json", anyPrompt()]);
  });
});

describe("provider invocation fixtures — antigravity", () => {
  it("delivers managed repository context to the provider prompt", () => {
    const prompt = managedPrompt();
    const inv = buildCliInvocation({ bot: "antigravity", prompt, sessionId: null, command: "agy" });
    expect(inv.args.join("\n")).toContain("selected-owner/selected-repo");
  });
  it("fresh session — exact arg order, no --conversation or disabled timeout flags", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy" });
    expect(inv.args[0]).toBe("--print");
    expect(inv.args).toHaveLength(2);
  });

  it("resumes an existing conversation — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: "conv-1", command: "agy" });
    expect(inv.args[0]).toBe("--conversation");
    expect(inv.args[1]).toBe("conv-1");
    expect(inv.args[2]).toBe("--print");
    expect(inv.args).toHaveLength(4);
  });

  it("trusted mode — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", executionMode: "trusted" });
    expect(inv.args[0]).toBe("--dangerously-skip-permissions");
    expect(inv.args[1]).toBe("--print");
  });

  it("tool-free mode — exact arg order, --sandbox present", () => {
    const inv = buildCliInvocation({ bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", toolMode: "none" });
    expect(inv.args[0]).toBe("--sandbox");
    expect(inv.args[1]).toBe("--print");
  });

  it("attachments are annotated inline into the prompt text, not passed as separate flags", () => {
    const inv = buildCliInvocation({
      bot: "antigravity", prompt: "hi", sessionId: null, command: "agy", attachments: ["/tmp/a.png"],
    });
    expect(inv.args).toHaveLength(2);
    expect(inv.args[inv.args.length - 1]).toContain("/tmp/a.png");
    expect(inv.stdin).toBeUndefined();
  });
});

describe("provider invocation fixtures — kimchi", () => {
  it("fresh session — exact arg order, --no-session", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi" });
    expect(inv.args).toEqual(["--print", "--no-session", anyPrompt()]);
  });

  it("resumes an existing session — exact arg order", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: "kim-1", command: "kimchi" });
    expect(inv.args).toEqual(["--print", "--resume", "kim-1", anyPrompt()]);
  });

  it("trusted mode — exact arg order, --yolo", () => {
    const inv = buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", executionMode: "trusted" });
    expect(inv.args).toEqual(["--print", "--yolo", "--no-session", anyPrompt()]);
  });

  it("tool-free mode is not supported for kimchi", () => {
    expect(() => buildCliInvocation({ bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", toolMode: "none" }))
      .toThrow(/tool-free mode.*kimchi/i);
  });

  it("attachments are annotated inline into the prompt text (no native attachment support) — exact arg order", () => {
    const inv = buildCliInvocation({
      bot: "kimchi", prompt: "hi", sessionId: null, command: "kimchi", attachments: ["/tmp/a.png"],
    });
    expect(inv.args).toHaveLength(3);
    expect(inv.args[inv.args.length - 1]).toContain("/tmp/a.png");
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

  it("codex: malformed/non-JSON lines are skipped without throwing", () => {
    const stdout = "not json\n{\"broken\n" + JSON.stringify({ type: "response.completed", output_text: "ok" });
    expect(() => parseCliResult({ bot: "codex", stdout })).not.toThrow();
    expect(parseCliResult({ bot: "codex", stdout }).text).toBe("ok");
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

  it("kimchi: parses plain stdout as text with no session id from stdout alone", () => {
    const result = parseCliResult({ bot: "kimchi", stdout: "kimchi says hi" });
    expect(result.text).toBe("kimchi says hi");
  });

  it("unknown bot type throws", () => {
    expect(() => parseCliResult({ bot: "unknown-bot", stdout: "x" })).toThrow(/Unknown bot type/);
  });
});

describe("provider result parsing fixtures — antigravity gaps (CTO review blocker 3)", () => {
  // Antigravity's JSON/fenced-JSON/legacy-***-delimiter/🧠-memory-marker/
  // STATUS-line-stripping/RESOURCE_EXHAUSTED-error parsing, and Kimchi's
  // thought/tool-call stripping and newest-session-file resolution, are
  // already exhaustively characterized in test/cli.test.ts ("antigravity
  // model mapping and settings override", "kimchi integration") and
  // test/bridge.test.ts (ensureAntigravityStateDirs, readAntigravityLastConversation,
  // readLatestAntigravityConversationFromLogs, resolveAntigravityConversationId,
  // extractAntigravityConversationId). These three were genuinely missing:

  it("timeout: stdout containing a timed-out marker throws a structured timeout error, not silent success", () => {
    expect(() => parseCliResult({ bot: "antigravity", stdout: "Error: timed out waiting for response from model" }))
      .toThrow(/timed out/i);
    expect(() => parseCliResult({ bot: "antigravity", stdout: "  error: timed out  " }))
      .toThrow(/timed out/i);
  });

  it("session: sessionId is extracted from logContent alongside the parsed text, not just text alone", () => {
    const stdout = JSON.stringify({ reasoning: "ok", response: "The answer." });
    const logContent = "Print mode: conversation=c107dfbd-181e-4cf0-a840-894662adee43, sending message";
    const result = parseCliResult({ bot: "antigravity", stdout, logContent });
    expect(result.text).toBe("The answer.");
    expect(result.sessionId).toBe("c107dfbd-181e-4cf0-a840-894662adee43");
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
    expect(isCapacityExhaustedError(new Error("CLI exited with code 1: command not found: kimchi"))).toBe(false);
  });
});
