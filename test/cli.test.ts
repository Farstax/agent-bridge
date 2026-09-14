import { describe, expect, it, vi, afterAll, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { runCli, runCliAsync, abortCliProcess, abortCliProcessAndWait, shutdownCliProcesses, shutdownCliProcessesAndWait, isCapacityExhaustedError, getNextFallbackModel, parseCliResult, buildCliInvocation, buildSafeChildEnv, buildAdvisorChildEnv } from "../src/cli.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliTestCwd = mkdtempSync(join(tmpdir(), "agent-bridge-cli-tests-"));
afterAll(() => rmSync(cliTestCwd, { recursive: true, force: true }));

describe("runCliAsync idle timeout", () => {
  it("rejects with idle timeout when process is silent and idleTimeoutMs is set", async () => {
    await expect(
      runCliAsync("bash", ["-lc", "sleep 5"], cliTestCwd, {
        timeoutMs: 500,
        idleTimeoutMs: 50,
        killGraceMs: 25,
      }),
    ).rejects.toThrow(/idle timeout/i);
  }, 2000);

});

describe("CLI Runner", () => {
  it("buildSafeChildEnv keeps context helper env while stripping Telegram secrets", () => {
    const env = buildSafeChildEnv({
      TELEGRAM_BOT_TOKEN: "secret",
      AGENT_BRIDGE_CONTEXT_AVAILABLE: "1",
      AGENT_BRIDGE_CONTEXT_COMMAND: "agent-bridge-context",
      AGENT_BRIDGE_CHAT_KEY: "chat:1",
    });

    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.AGENT_BRIDGE_CONTEXT_AVAILABLE).toBe("1");
    expect(env.AGENT_BRIDGE_CONTEXT_COMMAND).toBe("agent-bridge-context");
    expect(env.AGENT_BRIDGE_CHAT_KEY).toBe("chat:1");
  });

  it("buildAdvisorChildEnv strips advisor capability and trusted configuration", () => {
    const env = buildAdvisorChildEnv({
      HOME: "/home/test",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "provider-auth",
      AGENT_BRIDGE_ADVISOR_CAPABILITY: "capability",
      AGENT_BRIDGE_ADVISOR_COMMAND: "command",
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_CHAIN: "claude:model",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
    });
    expect(env.HOME).toBe("/home/test");
    expect(env.ANTHROPIC_API_KEY).toBe("provider-auth");
    expect(env.AGENT_BRIDGE_ADVISOR_CAPABILITY).toBeUndefined();
    expect(env.AGENT_BRIDGE_ADVISOR_COMMAND).toBeUndefined();
    expect(env.BRIDGE_ADVISOR_ENABLED).toBeUndefined();
    expect(env.BRIDGE_ADVISOR_CHAIN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("rejects unsupported tool-free providers", () => {
    const agy = buildCliInvocation({
      bot: "antigravity", prompt: "advise", sessionId: null, command: "agy_acp_server.par",
      model: "gemini-3.5-flash-high", outputFormat: "json", toolMode: "none",
    });
    expect(agy.transport).toBe("acp-stdio");
    expect(agy.args).not.toContain("--sandbox");

    expect(() => buildCliInvocation({
      bot: "codex", prompt: "advise", sessionId: null, command: "codex-acp",
      model: "gpt-5.6-luna", outputFormat: "json", toolMode: "none",
    })).toThrow("Tool-free mode is not supported for codex");

  });

  it("passes contextEnv into child processes", async () => {
    const output = await runCli(
      process.execPath,
      ["-e", "console.log(process.env.AGENT_BRIDGE_CONTEXT_AVAILABLE + ':' + process.env.AGENT_BRIDGE_CHAT_KEY)"],
      cliTestCwd,
      { contextEnv: { AGENT_BRIDGE_CONTEXT_AVAILABLE: "1", AGENT_BRIDGE_CHAT_KEY: "chat:1" } } as any,
    );

    expect(output.trim()).toBe("1:chat:1");
  });

  it("runs a simple command and returns stdout", async () => {
    const output = await runCli("echo", ["hello"], cliTestCwd);
    expect(output.trim()).toBe("hello");
  });

  it("closes stdin so commands that wait for input can finish", async () => {
    const output = await runCli("bash", ["-lc", "read -r _ || true; echo done"], cliTestCwd, {
      timeoutMs: 2000,
    });
    expect(output).toContain("done");
  }, 5000);

  it("logs spawn details for debugging", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli("echo", ["hello world"], cliTestCwd, { chatId: "debug-chat" });
    expect(spy.mock.calls.some((call) => String(call[0]).includes("[spawn]") && String(call[0]).includes("debug-chat"))).toBe(true);
    spy.mockRestore();
  });

  it("throws on non-zero exit code", async () => {
    await expect(runCli("false", [], cliTestCwd)).rejects.toThrow();
  });

  it("handles async progress", async () => {
    const chunks: string[] = [];
    const result = await runCliAsync("echo", ["hello world"], cliTestCwd, {
      onProgress: (c) => chunks.push(c),
    });
    expect(result.text).toContain("hello world");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("resolves cleanly when aborted mid-run", async () => {
    const chatId = "test-cancel-midrun";
    const p = runCliAsync("sleep", ["10"], cliTestCwd, { chatId });
    await new Promise((r) => setTimeout(r, 50));
    abortCliProcess(chatId);
    await expect(p).resolves.toMatchObject({ text: expect.any(String) });
  }, 5000);
});

describe("abortCliProcess", () => {
  afterEach(() => {
    shutdownCliProcesses();
  });

  it("returns false when no process is registered for the chatId", () => {
    expect(abortCliProcess("chat-does-not-exist")).toBe(false);
  });

  it("waits for child exit before resolving termination", async () => {
    const chatId = "test-abort-waits-for-exit";
    const childRun = runCli(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000)"], cliTestCwd, { chatId });
    await new Promise((r) => setTimeout(r, 300));
    let settled = false;
    const abort = abortCliProcessAndWait(chatId).then((value) => { settled = true; return value; });
    await new Promise((r) => setTimeout(r, 100));
    expect(settled).toBe(false);
    await expect(abort).resolves.toBe(true);
    await expect(childRun).resolves.toEqual(expect.any(String));
  }, 8_000);

  it("resolves cleanly when process is killed via abortCliProcess (runCliAsync)", async () => {
    const chatId = "test-abort-async";
    const p = runCliAsync("sleep", ["10"], cliTestCwd, { chatId });
    // Give spawn a tick to register
    await new Promise((r) => setTimeout(r, 50));
    const aborted = abortCliProcess(chatId);
    expect(aborted).toBe(true);
    // Should resolve (not reject) with partial stdout
    await expect(p).resolves.toMatchObject({ text: expect.any(String) });
  }, 5000);

  it("resolves cleanly when process is killed via abortCliProcess (runCli)", async () => {
    const chatId = "test-abort-sync";
    const p = runCli("sleep", ["10"], cliTestCwd, { chatId });
    await new Promise((r) => setTimeout(r, 50));
    const aborted = abortCliProcess(chatId);
    expect(aborted).toBe(true);
    await expect(p).resolves.toEqual(expect.any(String));
  }, 5000);

  it("keeps a newer process registered when an older process for the same chat closes late", async () => {
    const chatId = "test-reregister-race";
    const first = runCli("echo", ["fast"], cliTestCwd, { chatId });
    const second = runCli("sleep", ["10"], cliTestCwd, { chatId });
    await first;
    await new Promise((r) => setTimeout(r, 50));
    // The stale close of the first process must not deregister the second.
    expect(abortCliProcess(chatId)).toBe(true);
    await expect(second).resolves.toEqual(expect.any(String));
  }, 5000);

  it("returns false for already-completed process", async () => {
    const chatId = "test-abort-done";
    await runCli("echo", ["hi"], cliTestCwd, { chatId });
    expect(abortCliProcess(chatId)).toBe(false);
  });

  it("kills all tracked processes during shutdown", async () => {
    const asyncPromise = runCliAsync("sleep", ["10"], cliTestCwd, { chatId: "shutdown-async" });
    const syncPromise = runCli("sleep", ["10"], cliTestCwd, { chatId: "shutdown-sync" });
    await new Promise((r) => setTimeout(r, 50));

    expect(shutdownCliProcesses()).toBe(2);
    await expect(asyncPromise).resolves.toMatchObject({ text: expect.any(String) });
    await expect(syncPromise).resolves.toEqual(expect.any(String));
  }, 5000);
});

describe("model fallback", () => {
  it("detects capacity-exhausted errors by message content", () => {
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: No capacity available for model gemini-2.5-flash")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: MODEL_CAPACITY_EXHAUSTED")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your limit · resets 2:40am (Europe/London)")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your session limit · resets 1pm (Europe/London)")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: You've hit your usage limit. Upgrade to Pro...")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error(`CLI exited with code 1: {"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"You've hit your limit · resets 2:40am (Europe/London)"}`)
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: Error: Model \"glm-5.2-fp8\" not found.")
    )).toBe(true);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: Error: unknown model minimax-m2.5")
    )).toBe(true);
    expect(isCapacityExhaustedError(new Error("CLI hard timeout after 120000ms"))).toBe(false);
    expect(isCapacityExhaustedError(new Error("Network error"))).toBe(false);
  });

  it("awaits every tracked child close during deterministic shutdown", async () => {
    const first = runCli(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000)"], cliTestCwd, { chatId: "shutdown-wait-a", killGraceMs: 50 });
    const second = runCliAsync(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>{},10000)"], cliTestCwd, { chatId: "shutdown-wait-b", killGraceMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(shutdownCliProcessesAndWait()).resolves.toBe(2);
    await expect(first).resolves.toEqual(expect.any(String));
    await expect(second).resolves.toMatchObject({ text: expect.any(String) });
    expect(abortCliProcess("shutdown-wait-a")).toBe(false);
    expect(abortCliProcess("shutdown-wait-b")).toBe(false);
  });

  it("does not treat non-model 'not found' errors as capacity exhaustion", () => {
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: Error: Session abc-123 not found.")
    )).toBe(false);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: ENOENT: no such file or directory, config.json not found")
    )).toBe(false);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: fatal: repository 'origin' does not exist")
    )).toBe(false);
    expect(isCapacityExhaustedError(
      new Error("CLI exited with code 1: command not found: unsupported-provider")
    )).toBe(false);
  });

  it("returns the next model in the preference list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-2.5-flash", prefs)).toBe("gemini-2.5-flash-lite");
  });

  it("returns null when already at the last model in the list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-2.5-flash-lite", prefs)).toBeNull();
  });

  it("returns null when current model is not in the preference list", () => {
    const prefs = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
    expect(getNextFallbackModel("gemini-unknown", prefs)).toBeNull();
  });

  it("returns null when current model is null", () => {
    expect(getNextFallbackModel(null, ["gemini-2.5-flash", "gemini-2.5-flash-lite"])).toBeNull();
  });

  it("returns null when preference list has only one entry", () => {
    expect(getNextFallbackModel("gemini-2.5-flash", ["gemini-2.5-flash"])).toBeNull();
  });

  it("walks a three-model chain correctly", () => {
    const prefs = ["a", "b", "c"];
    expect(getNextFallbackModel("a", prefs)).toBe("b");
    expect(getNextFallbackModel("b", prefs)).toBe("c");
    expect(getNextFallbackModel("c", prefs)).toBeNull();
  });

});

describe("antigravity ACP result contract", () => {
  it("does not parse native stream-json after ACP migration", () => {
    expect(() => parseCliResult({ bot: "antigravity", stdout: "" })).toThrow(/ACP structured results/);
    expect(() => parseCliResult({
      bot: "antigravity",
      stdout: JSON.stringify({
        event: "result",
        result: { conversation_id: "11111111-2222-3333-4444-555555555555", status: "SUCCESS", response: "ok" },
      }),
    })).toThrow(/ACP structured results/);
  });
});

// Steps 3, 4, 5, 8 — attachment + outputDir support in buildCliInvocation

describe("buildCliInvocation — attachment injection", () => {
  const base = { prompt: "hello", sessionId: null, command: "agy", model: null };

  it("agy: keeps ACP argv free of attachment path flags", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "antigravity",
      attachments: ["/tmp/x.jpg", "/tmp/y.png"],
    });
    expect(invocation.transport).toBe("acp-stdio");
    expect(invocation.args).toEqual(["--uid="]);
    expect(invocation.args.join(" ")).not.toContain("/tmp/x.jpg");
  });

  it("agy: no annotation when attachments is empty", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "antigravity",
      attachments: [],
    });
    expect(invocation.prompt).not.toContain("[Attached file saved at:");
  });

  it("codex: no -i flags when attachments is empty", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "codex",
      command: "codex",
      attachments: [],
    });
    expect(args).not.toContain("-i");
  });

  it("all bots: ACP invocation carries the outputDir on the request path, not native argv", () => {
    for (const bot of ["antigravity"] as const) {
      const invocation = buildCliInvocation({
        ...base,
        bot,
        command: "cmd",
        outputDir: "/tmp/bridge-out/42",
      });
      expect(invocation.transport).toBe("acp-stdio");
      expect(invocation.args).not.toContain("/tmp/bridge-out/42");
    }
  });

  it("wraps prompts with the execution contract when Soul is absent", () => {
    const invocation = buildCliInvocation({
      ...base,
      bot: "antigravity",
      command: "agy",
      includeResponseContract: false,
    });
    expect(invocation.prompt).toContain("Agent Bridge execution contract:");
    expect(invocation.prompt).toContain("hello");
    expect(invocation.prompt).not.toContain("Keep replies extremely concise");
  });
});

describe("buildCliInvocation — effort flags", () => {
  const base = { prompt: "hello", sessionId: null, model: null };

  it("leaves Agy effort unimplemented because the CLI has no effort flag", () => {
    const { args } = buildCliInvocation({
      ...base,
      bot: "antigravity",
      command: "agy",
      effort: "max",
    });
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("model_reasoning_effort=\"max\"");
  });
});

describe("buildSafeChildEnv", () => {
  it("strips TELEGRAM_BOT_TOKEN_* vars from the env", async () => {
    const { buildSafeChildEnv } = await import("../src/cli.js");
    const env = buildSafeChildEnv({
      PATH: "/usr/bin",
      TELEGRAM_BOT_TOKEN_CLAUDE: "secret1",
      TELEGRAM_BOT_TOKEN_CODEX: "secret2",
      TELEGRAM_BOT_TOKEN_ANTIGRAVITY: "secret3",
      HOME: "/home/user",
    });
    expect(env.TELEGRAM_BOT_TOKEN_CLAUDE).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN_CODEX).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN_ANTIGRAVITY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
  });

  it("also strips TELEGRAM_BOT_TOKEN (unqualified) and TELEGRAM_ALLOWED_USER_IDS", async () => {
    const { buildSafeChildEnv } = await import("../src/cli.js");
    const env = buildSafeChildEnv({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_IDS: "123",
      OTHER: "keep",
    });
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_ALLOWED_USER_IDS).toBeUndefined();
    expect(env.OTHER).toBe("keep");
  });
});

describe("scrubOutputDir", () => {
  it("removes lines that contain the output dir path", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Image generated.\n\nSaved to /tmp/bridge-out/codex-42/image.png\n\nHere is your result.";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("Image generated.\n\nHere is your result.");
  });

  it("removes the entire line when path appears mid-sentence", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Done.\nFile written: /tmp/bridge-out/codex-42/out.jpg\nEnjoy.";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("Done.\nEnjoy.");
  });

  it("collapses multiple blank lines left by removed lines", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "A\n\n/tmp/bridge-out/codex-42/x.png\n\nB";
    expect(scrubOutputDir(text, "/tmp/bridge-out/codex-42")).toBe("A\n\nB");
  });

  it("returns text unchanged when outDir is null", async () => {
    const { scrubOutputDir } = await import("../src/cli.js");
    const text = "Some text with no path.";
    expect(scrubOutputDir(text, null)).toBe(text);
  });
});

describe("redactArgs — spawn log prompt redaction", () => {
  it("keeps short args intact", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const args = ["--print", "--model", "claude-sonnet-4-6", "--output-format", "json"];
    expect(redactArgs(args)).toEqual(args);
  });

  it("redacts args longer than 100 chars with a placeholder", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const longPrompt = "A".repeat(200);
    const result = redactArgs(["--print", longPrompt]);
    expect(result[0]).toBe("--print");
    expect(result[1]).toMatch(/^\[prompt: \d+chars\]$/);
    expect(result[1]).not.toContain("A");
  });

  it("placeholder includes the original char count", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const result = redactArgs(["A".repeat(150)]);
    expect(result[0]).toContain("150chars");
  });

  it("does not redact args exactly at the 100-char boundary", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const arg = "x".repeat(100);
    expect(redactArgs([arg])).toEqual([arg]);
  });

  it("redacts args over 100 chars (101+)", async () => {
    const { redactArgs } = await import("../src/cli.js");
    const arg = "x".repeat(101);
    expect(redactArgs([arg])[0]).toMatch(/^\[prompt:/);
  });
});

describe("wrapAntigravityPrompt — liveness and narration", () => {
  const base = { prompt: "do something long", sessionId: null, command: "agy", model: null };

  function getAgyPrompt(): string {
    return buildCliInvocation({ ...base, bot: "antigravity" }).prompt ?? "";
  }

  it("does not contain the old LIVENESS RULE idle-timeout coupling", () => {
    const prompt = getAgyPrompt();
    expect(prompt).not.toContain("LIVENESS RULE");
    expect(prompt).not.toContain("idle timeout termination");
  });

  it("does not instruct bare PING output", () => {
    const prompt = getAgyPrompt();
    expect(prompt).not.toMatch(/'PING'/);
  });

  it("does not impose the retired inner JSON response envelope or STATUS narration", () => {
    const prompt = getAgyPrompt();
    expect(prompt).not.toContain('"response"');
    expect(prompt).not.toContain('"reasoning"');
    expect(prompt).not.toContain("STATUS:");
  });
});

describe("runCli process tree kill on timeout", () => {
  it("kills grandchild processes when the sync path hits an idle timeout", async () => {
    const pidFile = `/tmp/agent-bridge-test-grandchild-${process.pid}.pid`;
    const p = runCli(
      "bash",
      ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      cliTestCwd,
      { idleTimeoutMs: 500, timeoutMs: 10_000, killGraceMs: 200 },
    );
    await expect(p).rejects.toThrow(/idle timeout/);
    // allow SIGTERM/SIGKILL grace to complete
    await new Promise((r) => setTimeout(r, 600));
    const { readFileSync: rf, rmSync: rm } = await import("node:fs");
    const grandchildPid = parseInt(rf(pidFile, "utf8").trim(), 10);
    rm(pidFile, { force: true });
    expect(Number.isFinite(grandchildPid)).toBe(true);
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch { /* cleanup */ }
    }
    expect(alive).toBe(false);
  }, 15_000);
});
