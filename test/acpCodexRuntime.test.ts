import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { buildCliInvocation, runProviderInvocation } from "../src/cli.js";
import { runTurn, codexAcpChildAuthEnv } from "../src/providers/codexAcpRuntime.js";
import { resolveCodexRuntime, isCodexAcpRuntime } from "../src/providers/codexRuntimeSelection.js";
import { abortCliProcess, isChildRunning } from "../src/cliSupervisor.js";
import { liveDeliveryText } from "../src/acp/index.js";
import {
  isInvalidProviderSessionError,
  lookupEngineProviderSession,
  persistEngineProviderSession,
} from "../src/engine.js";
import { verifyProviderApiKey } from "../src/providers/apiKeyAuth.js";

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
  it("auto-authenticates the ACP adapter from a workspace-local CODEX_API_KEY", () => {
    expect(codexAcpChildAuthEnv({ CODEX_API_KEY: "sk-test" })).toEqual({
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }),
    });
    expect(codexAcpChildAuthEnv({
      CODEX_API_KEY: "sk-test",
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "chatgpt" }),
    })).toEqual({});
    expect(codexAcpChildAuthEnv({})).toEqual({});
  });

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

  it("fails closed on toolMode \"none\" instead of weakening to ACP read-only", () => {
    const previous = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
    process.env.CODEX_ACP_COMMAND = "codex-acp";
    try {
      expect(() => buildCliInvocation({
        bot: "codex",
        prompt: "hi",
        sessionId: null,
        command: "codex",
        toolMode: "none",
      })).toThrow(/tool-free/i);
    } finally {
      if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previous;
      delete process.env.CODEX_ACP_COMMAND;
    }
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
    expect(db.getAcpSessionBinding("conv-1", "codex")?.runId).toBe("run-1");
    expect(db.getAcpSessionBinding("conv-1", "codex")?.acpSessionId).not.toBe("conv-1");
    db.clearAcpSessionBinding("conv-1", "codex");
    expect(db.getAcpSessionBinding("conv-1", "codex")).toBeNull();
    db.close();
  });

  it("refuses to persist an ACP session id that equals the Bridge conversation id", () => {
    const db = openDb(":memory:");
    expect(() => db.putAcpSessionBinding({
      conversationId: "conv-1",
      providerId: "codex",
      acpSessionId: "conv-1",
      runId: "run-1",
    })).toThrow(/must not equal/);
    db.close();
  });

  it("stores ACP bindings beside Bridge conversation identity without writing the sessions table", () => {
    const previous = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
    const db = openDb(":memory:");
    try {
      persistEngineProviderSession(db, "conv-bridge-1", "codex", "acp-sess-aaa", "run-9");
      expect(lookupEngineProviderSession(db, "conv-bridge-1", "codex")).toBe("acp-sess-aaa");
      expect(db.getAcpSessionBinding("conv-bridge-1", "codex")).toEqual({
        conversationId: "conv-bridge-1",
        providerId: "codex",
        acpSessionId: "acp-sess-aaa",
        runId: "run-9",
      });
      expect(db.getSession("conv-bridge-1", "codex")).toBeNull();
    } finally {
      db.close();
      if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previous;
    }
  });

  it("does not resume a pre-ACP legacy session after intervening ACP turns", () => {
    const previous = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    const db = openDb(":memory:");
    try {
      // Legacy session L exists before any ACP turn.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "legacy";
      persistEngineProviderSession(db, "conv-transition-1", "codex", "legacy-session-L", "run-legacy");
      expect(lookupEngineProviderSession(db, "conv-transition-1", "codex")).toBe("legacy-session-L");

      // Switch to ACP and complete a turn.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
      persistEngineProviderSession(db, "conv-transition-1", "codex", "acp-session-A", "run-acp");
      expect(lookupEngineProviderSession(db, "conv-transition-1", "codex")).toBe("acp-session-A");

      // Switch back to legacy: L predates the ACP turns and must not resume.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "legacy";
      expect(lookupEngineProviderSession(db, "conv-transition-1", "codex")).toBeNull();
    } finally {
      db.close();
      if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previous;
    }
  });

  it("does not resume a pre-legacy ACP session after intervening legacy turns", () => {
    const previous = process.env.AGENT_BRIDGE_CODEX_RUNTIME;
    const db = openDb(":memory:");
    try {
      // ACP session A exists before any legacy turn.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
      persistEngineProviderSession(db, "conv-transition-2", "codex", "acp-session-A2", "run-acp");
      expect(lookupEngineProviderSession(db, "conv-transition-2", "codex")).toBe("acp-session-A2");

      // Switch to legacy and complete a turn.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "legacy";
      persistEngineProviderSession(db, "conv-transition-2", "codex", "legacy-session-L2", "run-legacy");
      expect(lookupEngineProviderSession(db, "conv-transition-2", "codex")).toBe("legacy-session-L2");

      // Switch back to ACP: A predates the legacy turn and must not resume.
      process.env.AGENT_BRIDGE_CODEX_RUNTIME = "acp";
      expect(lookupEngineProviderSession(db, "conv-transition-2", "codex")).toBeNull();
    } finally {
      db.close();
      if (previous === undefined) delete process.env.AGENT_BRIDGE_CODEX_RUNTIME;
      else process.env.AGENT_BRIDGE_CODEX_RUNTIME = previous;
    }
  });

  it("treats ACP unknown-session and unresumable-session errors as recoverable invalid ids", () => {
    expect(isInvalidProviderSessionError("Unknown session: acp-sess-1")).toBe(true);
    expect(isInvalidProviderSessionError("ACP agent does not support resume or load for an existing session")).toBe(true);
    expect(isInvalidProviderSessionError("No conversation found with session ID: abc")).toBe(true);
    expect(isInvalidProviderSessionError("CLI exited with code 1")).toBe(false);
    const wrapped = Object.assign(new Error("Internal error"), {
      data: { details: "thread not found" },
    });
    expect(isInvalidProviderSessionError(wrapped)).toBe(true);
    expect(isInvalidProviderSessionError(new Error("Internal error"))).toBe(false);
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

    expect(first.text).toContain("User request:\nfirst");
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

    expect(second.text).toContain("User request:\nsecond");
    expect(second.text).not.toMatch(/User request:\nfirst/);
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

  it("retains rich ACP events through the real Bridge event sink, distinct from delivered text", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    const storeDir = mkdtempSync(join(tmpdir(), "fake-acp-store-"));
    process.env.FAKE_ACP_STORE = join(storeDir, "sessions.json");
    const { EventStore } = await import("../src/events/store.js");
    const db = openDb(":memory:");
    try {
      const firstStore = new EventStore(db);
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
        chatId: "acp-events-1",
        eventContext: { runId: "run-events-1", bot: "codex", chatId: "acp-events-1", chatKey: "acp-events-1" },
        onEvent: (e) => firstStore.collect(e),
      }, { conversationId: "conv-events-1", runId: "run-events-1" });

      const secondStore = new EventStore(db);
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
        chatId: "acp-events-2",
        eventContext: { runId: "run-events-2", bot: "codex", chatId: "acp-events-2", chatKey: "acp-events-2" },
        onEvent: (e) => secondStore.collect(e),
      }, { conversationId: "conv-events-1", runId: "run-events-2" });

      const secondEvents = db.getEventsForRun("run-events-2").filter((e) => e.type === "acp.retained");
      expect(secondEvents).toHaveLength(1);
      const retained = JSON.parse(secondEvents[0].payload_json);
      expect(retained.sessionMode).toBe("load");
      expect(retained.events.some((e: { kind: string }) => e.kind === "tool_call" || (e.kind === "session_update" && e.notification?.update?.sessionUpdate === "tool_call"))).toBe(true);
      expect(retained.events.some((e: { channel: string; notification?: { update?: { sessionUpdate?: string } } }) =>
        e.channel === "replay" && e.notification?.update?.sessionUpdate === "agent_message_chunk")).toBe(true);
      // Telegram/Discord delivery only ever reads live agent_message_chunk text off `second.text`, never this event.
      expect(second.text).toContain("User request:\nsecond");
      expect(second.text).not.toMatch(/User request:\nfirst/);
    } finally {
      db.close();
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

  it("wraps soul and output-dir instructions into the ACP prompt", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    try {
      const result = await runTurn({
        prompt: "hello-soul",
        sessionId: null,
        command: "codex-acp",
        model: null,
        executionMode: "trusted",
        outputFormat: "json",
        soulContext: "SOUL_MARKER_FOR_ACP",
        includeResponseContract: true,
        attachments: [],
        outputDir: "/tmp/bridge-acp-out",
        effort: null,
        toolMode: "default",
      }, process.cwd(), {
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
        chatId: `acp-soul-${Date.now()}`,
      }, { conversationId: "conv-soul", runId: "run-soul" });
      expect(result.text).toContain("SOUL_MARKER_FOR_ACP");
      expect(result.text).toContain("/tmp/bridge-acp-out");
      expect(result.text).toContain("hello-soul");
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("redacts provider secrets from live ACP delivery text", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    const apiKey = "codex-acp-secret-do-not-leak";
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    await verifyProviderApiKey("codex", {
      env: { CODEX_API_KEY: apiKey },
      execFile: async () => undefined,
    });
    const progress: string[] = [];
    try {
      const result = await runTurn({
        prompt: `echo ${apiKey}`,
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
        chatId: `acp-redact-${Date.now()}`,
        contextEnv: { CODEX_API_KEY: apiKey },
        onProgress: (chunk) => progress.push(chunk),
      }, { conversationId: "conv-redact", runId: "run-redact" });
      expect(result.text).not.toContain(apiKey);
      expect(result.text).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
      expect(progress.join("")).not.toContain(apiKey);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("times out a hung ACP stdio child", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    try {
      await expect(runTurn({
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
        timeoutMs: 200,
        idleTimeoutMs: 200,
        chatId: `acp-timeout-${Date.now()}`,
      }, { conversationId: "conv-timeout", runId: "run-timeout" })).rejects.toThrow(/timeout/i);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("fails closed when the ACP child dies before initialize", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = "-e process.exit(1)";
    try {
      await expect(runTurn({
        prompt: "hello",
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
        timeoutMs: 3_000,
        idleTimeoutMs: 3_000,
        chatId: `acp-dead-${Date.now()}`,
      }, { conversationId: "conv-dead", runId: "run-dead" })).rejects.toThrow();
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);

  it("fails closed on malformed ACP stdio", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = "-e console.log('not-json')";
    try {
      await expect(runTurn({
        prompt: "hello",
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
        timeoutMs: 3_000,
        idleTimeoutMs: 3_000,
        chatId: `acp-malformed-${Date.now()}`,
      }, { conversationId: "conv-malformed", runId: "run-malformed" })).rejects.toThrow();
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
        toolMode: "default",
      });
      expect(result.text).toContain("User request:\nqualify");
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
