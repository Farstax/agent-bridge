import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { buildCliInvocation, runProviderInvocation } from "../src/cli.js";
import { runTurn } from "../src/providers/codexAcpRuntime.js";
import { resolveCodexRuntime, isCodexAcpRuntime } from "../src/providers/codexRuntimeSelection.js";
import { abortCliProcess, isChildRunning } from "../src/cliSupervisor.js";
import { liveDeliveryText } from "../src/acp/index.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));

describe("Codex runtime selection", () => {
  it("defaults to the legacy Codex path", () => {
    expect(resolveCodexRuntime({})).toBe("legacy");
    expect(isCodexAcpRuntime("codex", {})).toBe(false);
  });

  it("selects ACP only when explicitly requested", () => {
    expect(resolveCodexRuntime({ AGENT_BRIDGE_CODEX_RUNTIME: "acp" })).toBe("acp");
    expect(isCodexAcpRuntime("codex", { AGENT_BRIDGE_CODEX_RUNTIME: "acp" })).toBe(true);
    expect(isCodexAcpRuntime("claude", { AGENT_BRIDGE_CODEX_RUNTIME: "acp" })).toBe(false);
  });

  it("refuses unknown runtime names rather than falling back", () => {
    expect(() => resolveCodexRuntime({ AGENT_BRIDGE_CODEX_RUNTIME: "auto" })).toThrow(/Unknown AGENT_BRIDGE_CODEX_RUNTIME/);
  });
});

describe("Codex ACP invocation", () => {
  it("builds an ACP stdio invocation instead of codex exec JSONL", () => {
    const previous = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    try {
      const inv = buildCliInvocation({
        bot: "codex",
        prompt: "hi",
        sessionId: "acp-sess-1",
        command: "codex",
        model: "gpt-5.6-luna",
        executionMode: "trusted",
      });
      expect(inv.transport).toBe("acp-stdio");
      expect(inv.command).toBe("codex-acp");
      expect(inv.args).toEqual([]);
      expect(inv.nativeSessionMode).toBe("resume");
      expect(inv.args.join(" ")).not.toContain("exec");
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previous;
      delete process.env.CODEX_ACP_COMMAND;
    }
  });

  it("keeps the legacy exec invocation when ACP is not selected", () => {
    const inv = buildCliInvocation({
      bot: "codex",
      prompt: "hi",
      sessionId: "thread-1",
      command: "codex",
    });
    expect(inv.transport ?? "oneshot").not.toBe("acp-stdio");
    expect(inv.args[0]).toBe("exec");
    expect(inv.args).toContain("resume");
  });
});

describe("ACP session persistence", () => {
  it("round-trips the mapping through SQLite and a reopened database", () => {
    const db = openDb(":memory:");
    db.putAcpSessionBinding({
      conversationId: "conv-1",
      providerId: "codex",
      acpSessionId: "acp-zzz",
      runId: "run-1",
    });
    expect(db.getAcpSessionBinding("conv-1", "codex")?.acpSessionId).toBe("acp-zzz");
    expect(db.getAcpSessionBinding("conv-1", "codex")?.conversationId).toBe("conv-1");
    expect(db.getAcpSessionBinding("conv-1", "codex")?.acpSessionId).not.toBe("conv-1");
    db.clearAcpSessionBinding("conv-1", "codex");
    expect(db.getAcpSessionBinding("conv-1", "codex")).toBeNull();
    db.close();
  });
});

describe("Codex ACP supervised stdio turn", () => {
  it("runs a fake ACP agent under the supervisor and suppresses replayed delivery text", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    const storeDir = mkdtempSync(join(tmpdir(), "fake-acp-store-"));
    process.env.FAKE_ACP_STORE = join(storeDir, "sessions.json");
    try {
    const first = await runTurn({
      prompt: "first",
      sessionId: null,
      command: "codex-acp",
      model: null,
      executionMode: "trusted",
      outputFormat: "json",
      soulContext: null,
      attachments: [],
      outputDir: null,
      effort: null,
      toolMode: "default",
    }, process.cwd(), {
      timeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      chatId: `acp-test-${Date.now()}`,
    }, { conversationId: "conv-bridge-1", runId: "run-1" });

    expect(first.text).toBe("live:first");
    expect(first.sessionId).toMatch(/^acp-/);
    expect(first.sessionId).not.toBe("conv-bridge-1");
    expect(first.telemetry?.outputTokens).toBe(8);

    const second = await runTurn({
      prompt: "second",
      sessionId: first.sessionId,
      command: "codex-acp",
      model: null,
      executionMode: "trusted",
      outputFormat: "json",
      soulContext: null,
      attachments: [],
      outputDir: null,
      effort: null,
      toolMode: "default",
    }, process.cwd(), {
      timeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      chatId: `acp-test-${Date.now()}-2`,
    }, { conversationId: "conv-bridge-1", runId: "run-2" });

    expect(second.text).toBe("live:second");
    expect(second.text).not.toContain("first");
    expect(liveDeliveryText([])).toBe("");
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
      delete process.env.FAKE_ACP_STORE;
      rmSync(storeDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("aborts a supervised ACP child through abortCliProcess", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    const chatId = `acp-stop-${Date.now()}`;
    try {
      const hung = runTurn({
        prompt: "HANG",
        sessionId: null,
        command: "codex-acp",
        model: null,
        executionMode: "trusted",
        outputFormat: "json",
        soulContext: null,
        attachments: [],
        outputDir: null,
        effort: null,
        toolMode: "default",
      }, process.cwd(), {
        timeoutMs: 8_000,
        idleTimeoutMs: 8_000,
        chatId,
      }, { conversationId: "conv-stop", runId: "run-stop" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(abortCliProcess(chatId)).toBe(true);
      await hung.catch(() => undefined);
      expect(isChildRunning(chatId)).toBe(false);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("runs ACP transport through runProviderInvocation instead of oneshot parse", async () => {
    const previousRuntime = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    try {
      const invocation = buildCliInvocation({
        bot: "codex",
        prompt: "qualify",
        sessionId: null,
        command: "codex",
      });
      expect(invocation.transport).toBe("acp-stdio");
      const result = await runProviderInvocation("codex", invocation, process.cwd(), {
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        bot: "codex",
        chatId: `acp-qualify-${Date.now()}`,
      }, {
        prompt: "qualify",
        sessionId: null,
        command: invocation.command,
        model: null,
        executionMode: "safe",
        outputFormat: "json",
        soulContext: null,
        attachments: [],
        outputDir: null,
        effort: null,
        toolMode: "none",
      });
      expect(result.text).toBe("live:qualify");
      expect(result.sessionId).toMatch(/^acp-/);
    } finally {
      if (previousRuntime === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previousRuntime;
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);
});
