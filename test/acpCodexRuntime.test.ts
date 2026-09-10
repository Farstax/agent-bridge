import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { buildCliInvocation, runProviderInvocation } from "../src/cli.js";
import { runTurn, codexAcpChildAuthEnv, toCliResult, initialAgentMode } from "../src/providers/codexAcpRuntime.js";
import { createCodexAcpAnswerPreview } from "../src/providers/codexAcpAnswerPreview.js";
import { abortCliProcess, isChildRunning } from "../src/cliSupervisor.js";
import { liveDeliveryText } from "../src/acp/index.js";
import {
  isInvalidProviderSessionError,
  lookupEngineProviderSession,
  persistEngineProviderSession,
} from "../src/engine.js";
import { verifyProviderApiKey } from "../src/providers/apiKeyAuth.js";

const fakeAgent = fileURLToPath(new URL("./support/fakeAcpAgent.ts", import.meta.url));

describe("Codex ACP provisional answer classification", () => {
  function event({
    channel = "live",
    sessionUpdate = "agent_message_chunk",
    text = "",
    updateMeta,
    notificationMeta,
  }: {
    channel?: "live" | "replay";
    sessionUpdate?: string;
    text?: string;
    updateMeta?: unknown;
    notificationMeta?: unknown;
  }) {
    const update: any = sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk"
      ? { sessionUpdate, content: { type: "text", text } }
      : { sessionUpdate, text };
    if (updateMeta !== undefined) update._meta = updateMeta;
    const notification: any = { sessionId: "acp-1", update };
    if (notificationMeta !== undefined) notification._meta = notificationMeta;
    return { kind: "session_update" as const, channel, notification } as any;
  }

  function previewCollector(secrets: string[] = []) {
    const chunks: string[] = [];
    const preview = createCodexAcpAnswerPreview((text) => chunks.push(text), secrets);
    return { chunks, preview };
  }

  it("previews unphased live agent messages", () => {
    const { chunks, preview } = previewCollector();
    preview.observe(event({ text: "hello" }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("hello");
  });

  it("previews explicit final_answer chunks", () => {
    const { chunks, preview } = previewCollector();
    preview.observe(event({ text: "answer", updateMeta: { codex: { phase: "final_answer" } } }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("answer");
  });

  it("suppresses commentary and unphased chunks after phase semantics begin", () => {
    const { chunks, preview } = previewCollector();
    preview.observe(event({ text: "thinking", updateMeta: { codex: { phase: "commentary" } } }));
    preview.observe(event({ text: "ambiguous" }));
    preview.observe(event({ text: "answer", updateMeta: { codex: { phase: "final_answer" } } }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("answer");
  });

  it("fails closed for malformed scalar, null, and misplaced Codex markers", () => {
    for (const marked of [
      event({ text: "scalar", updateMeta: { codex: "bad" } }),
      event({ text: "null", updateMeta: { codex: null } }),
      event({ text: "null-phase", updateMeta: { codex: { phase: null } } }),
      event({ text: "scalar-phase", updateMeta: { codex: { phase: 7 } } }),
      event({ text: "unknown-phase", updateMeta: { codex: { phase: "unknown" } } }),
      event({ text: "misplaced", notificationMeta: { codex: { phase: "final_answer" } } }),
    ]) {
      const { chunks, preview } = previewCollector();
      preview.observe(marked);
      preview.observe(event({ text: "later-unphased" }));
      preview.finish("end_turn");
      expect(chunks.join("")).toBe("");
    }
  });

  it("never previews thought, replay, tool, status, or progress events", () => {
    const { chunks, preview } = previewCollector();
    preview.observe(event({ sessionUpdate: "agent_thought_chunk", text: "secret thought" }));
    preview.observe(event({ channel: "replay", text: "old answer" }));
    preview.observe(event({ sessionUpdate: "tool_call", text: "tool output" }));
    preview.observe(event({ sessionUpdate: "plan", text: "status" }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("");
  });

  it("suppresses unphased messages after a phase marker on a non-answer update", () => {
    const { chunks, preview } = previewCollector();
    preview.observe(event({
      sessionUpdate: "agent_thought_chunk",
      text: "thought",
      updateMeta: { codex: { phase: "commentary" } },
    }));
    preview.observe(event({ text: "ambiguous unphased message" }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("");
  });

  it("redacts secrets split across multiple answer deltas", () => {
    const secret = "split-secret-123";
    const { chunks, preview } = previewCollector([secret]);
    preview.observe(event({ text: "safe split-" }));
    preview.observe(event({ text: "secret-" }));
    preview.observe(event({ text: "123 done" }));
    preview.finish("end_turn");
    expect(chunks.join("")).toBe("safe [REDACTED_PROVIDER_CREDENTIAL] done");
    expect(chunks.join("")).not.toContain(secret);
  });

  it("does not flush buffered provisional text on provider cancellation", () => {
    const { chunks, preview } = previewCollector(["secret"]);
    preview.observe(event({ text: "sec" }));
    preview.finish("cancelled");
    expect(chunks.join("")).toBe("");
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
      delete process.env.CODEX_ACP_COMMAND;
    }
  });

  it("fails closed on toolMode \"none\" instead of weakening to ACP read-only", () => {
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
      delete process.env.CODEX_ACP_COMMAND;
    }
  });
});

describe("Codex ACP phase-aware final delivery", () => {
  // Real Codex ACP notifications carry the phase tag on the update payload
  // itself (`notification.update._meta.codex.phase`, via ACP's ContentChunk
  // `_meta`) — not on the SessionNotification envelope
  // (`notification._meta`), which ACP reserves for its own extensibility
  // metadata and is a structurally distinct field.
  function fixture(
    updates: Array<{ channel: "live" | "replay"; phase?: "commentary" | "final_answer" | "bogus"; omitMeta?: boolean; text: string }>,
    stopReason = "end_turn",
  ): Parameters<typeof toCliResult>[0] {
    const observed = updates.map((u) => ({
      channel: u.channel,
      notification: {
        sessionId: "acp-sess-1",
        update: {
          sessionUpdate: "agent_message_chunk" as const,
          content: { type: "text" as const, text: u.text },
          ...(u.phase !== undefined ? { _meta: { codex: { phase: u.phase } } } : {}),
        },
      },
    }));
    const liveText = observed.filter((u) => u.channel === "live").map((u) => u.notification.update.content.text).join("");
    return {
      conversationId: "conv-1",
      runId: "run-1",
      acpSessionId: "acp-sess-1",
      sessionMode: "fresh",
      stopReason,
      liveText,
      events: [],
      updates: observed,
      initialize: { protocolVersion: 1, agentCapabilities: {} } as any,
    } as any;
  }

  it("excludes commentary-phase chunks from the final delivered answer", () => {
    const result = toCliResult(fixture([
      { channel: "live", phase: "commentary", text: "thinking out loud..." },
      { channel: "live", phase: "final_answer", text: "the real answer" },
    ]));
    expect(result.text).toBe("the real answer");
    expect(result.text).not.toContain("thinking out loud");
  });

  it("preserves order and concatenates multiple final_answer chunks", () => {
    const result = toCliResult(fixture([
      { channel: "live", phase: "commentary", text: "planning..." },
      { channel: "live", phase: "final_answer", text: "part one. " },
      { channel: "live", phase: "commentary", text: "more thinking..." },
      { channel: "live", phase: "final_answer", text: "part two." },
    ]));
    expect(result.text).toBe("part one. part two.");
  });

  it("keeps concatenating all live text when the agent supplies no Codex phase metadata", () => {
    const result = toCliResult(fixture([
      { channel: "live", text: "part one " },
      { channel: "live", text: "part two" },
    ]));
    expect(result.text).toBe("part one part two");
  });

  it("fails closed instead of leaking commentary when a phase-aware turn never emits a final_answer chunk", () => {
    expect(() => toCliResult(fixture([
      { channel: "live", phase: "commentary", text: "only commentary, no final_answer phase" },
    ]))).toThrow(/final_answer/);
  });

  it("fails closed on a malformed phase value within an otherwise phase-aware turn", () => {
    expect(() => toCliResult(fixture([
      { channel: "live", phase: "bogus" as any, text: "unrecognized phase value" },
    ]))).toThrow(/final_answer/);
  });

  it("fails closed when update._meta.codex is a malformed scalar", () => {
    const malformed = fixture([
      { channel: "live", text: "commentary that must not be promoted" },
    ]) as any;
    malformed.updates[0].notification.update._meta = { codex: "malformed" };
    expect(() => toCliResult(malformed)).toThrow(/final_answer/);
  });

  it("fails closed when update._meta.codex is explicitly null", () => {
    const malformed = fixture([
      { channel: "live", text: "commentary that must not be promoted" },
    ]) as any;
    malformed.updates[0].notification.update._meta = { codex: null };
    expect(() => toCliResult(malformed)).toThrow(/final_answer/);
  });

  it("fails closed when Codex phase metadata is misplaced on the notification envelope", () => {
    const malformed = fixture([
      { channel: "live", text: "commentary that must not be promoted" },
    ]) as any;
    malformed.updates[0].notification._meta = { codex: { phase: "commentary" } };
    expect(() => toCliResult(malformed)).toThrow(/final_answer/);
  });

  it("excludes a chunk with no phase metadata inside an otherwise phase-aware turn", () => {
    const result = toCliResult(fixture([
      { channel: "live", omitMeta: true, text: "no phase tag on this one" },
      { channel: "live", phase: "final_answer", text: "the real answer" },
    ]));
    expect(result.text).toBe("the real answer");
  });

  it("still excludes replayed history regardless of phase metadata", () => {
    const result = toCliResult(fixture([
      { channel: "replay", phase: "final_answer", text: "replayed old answer" },
      { channel: "live", phase: "final_answer", text: "current answer" },
    ]));
    expect(result.text).toBe("current answer");
  });

  it("resolves without throwing on ACP semantic cancellation even with no valid final_answer, and propagates stopReason", () => {
    const result = toCliResult(fixture([
      { channel: "live", phase: "commentary", text: "cut off mid-thought" },
    ], "cancelled"));
    expect(result.text).toBe("");
    expect(result.stopReason).toBe("cancelled");
  });

  it("propagates a non-cancelled stopReason onto the CliResult", () => {
    const result = toCliResult(fixture([
      { channel: "live", text: "hi" },
    ], "max_tokens"));
    expect(result.stopReason).toBe("max_tokens");
  });
});

describe("Codex ACP authority mapping", () => {
  it("maps Bridge safe authority to Codex ACP read-only, never the self-approving \"agent\" mode", () => {
    expect(initialAgentMode({ executionMode: "safe", toolMode: "default" })).toBe("read-only");
  });

  it("maps Bridge trusted authority to Codex ACP full access", () => {
    expect(initialAgentMode({ executionMode: "trusted", toolMode: "default" })).toBe("agent-full-access");
  });

  it("fails closed for toolMode \"none\" in either execution mode", () => {
    expect(() => initialAgentMode({ executionMode: "safe", toolMode: "none" })).toThrow(/tool-free/i);
    expect(() => initialAgentMode({ executionMode: "trusted", toolMode: "none" })).toThrow(/tool-free/i);
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

  it("expires stale ACP session bindings after seven days on open, without disturbing conversation identity", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "acp-binding-expiry-"));
    const dbPath = join(storeDir, "bridge.sqlite");
    try {
      const first = openDb(dbPath);
      first.putAcpSessionBinding({
        conversationId: "conv-stale-1",
        providerId: "codex",
        acpSessionId: "acp-stale-sess",
        runId: "run-1",
      });
      first.raw.prepare(
        `UPDATE acp_session_bindings SET updated_at = datetime('now', '-8 days') WHERE conversation_id = ?`,
      ).run("conv-stale-1");
      first.close();

      const second = openDb(dbPath);
      // Stale native-resume pointer is gone; the next turn starts fresh.
      expect(second.getAcpSessionBinding("conv-stale-1", "codex")).toBeNull();
      second.close();
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("keeps an ACP session binding updated within the last seven days across reopen", () => {
    const storeDir = mkdtempSync(join(tmpdir(), "acp-binding-fresh-"));
    const dbPath = join(storeDir, "bridge.sqlite");
    try {
      const first = openDb(dbPath);
      first.putAcpSessionBinding({
        conversationId: "conv-fresh-1",
        providerId: "codex",
        acpSessionId: "acp-fresh-sess",
        runId: "run-1",
      });
      first.close();

      const second = openDb(dbPath);
      expect(second.getAcpSessionBinding("conv-fresh-1", "codex")?.acpSessionId).toBe("acp-fresh-sess");
      second.close();
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
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

  it("retains rich ACP events incrementally through the real Bridge event sink, distinct from delivered text", async () => {
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

      const secondEvents = db.getEventsForRun("run-events-2").filter((e) => e.type === "acp.event");
      // One durable row per ACP event, not one aggregate at turn completion.
      expect(secondEvents.length).toBeGreaterThan(1);
      const retained = secondEvents.map((e) => JSON.parse(e.payload_json));
      for (const r of retained) expect(r.sessionMode).toBe("load");
      expect(retained.some((r) => r.event.kind === "session_update" && r.event.notification?.update?.sessionUpdate === "tool_call")).toBe(true);
      expect(retained.some((r) =>
        r.event.channel === "replay" && r.event.notification?.update?.sessionUpdate === "agent_message_chunk")).toBe(true);
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

  it("redacts provider credentials from raw ACP tool payloads before they are persisted", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    process.env.FAKE_ACP_SECRET_PROBE = "sk-test-secret-value";
    const storeDir = mkdtempSync(join(tmpdir(), "fake-acp-store-"));
    process.env.FAKE_ACP_STORE = join(storeDir, "sessions.json");
    const { EventStore } = await import("../src/events/store.js");
    const db = openDb(":memory:");
    try {
      const store = new EventStore(db);
      await runTurn({
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
        chatId: "acp-secret-1",
        contextEnv: { CODEX_API_KEY: "sk-test-secret-value" },
        eventContext: { runId: "run-secret-1", bot: "codex", chatId: "acp-secret-1", chatKey: "acp-secret-1" },
        onEvent: (e) => store.collect(e),
      }, { conversationId: "conv-secret-1", runId: "run-secret-1" });

      const events = db.getEventsForRun("run-secret-1").filter((e) => e.type === "acp.event");
      expect(events.length).toBeGreaterThan(0);
      for (const row of events) {
        expect(row.payload_json).not.toContain("sk-test-secret-value");
      }
      const toolCallRow = events.find((e) => e.payload_json.includes("rawInput"));
      expect(toolCallRow).toBeDefined();
      expect(toolCallRow!.payload_json).toContain("REDACTED_PROVIDER_CREDENTIAL");
    } finally {
      db.close();
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
      delete process.env.FAKE_ACP_STORE;
      delete process.env.FAKE_ACP_SECRET_PROBE;
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
      codexAcpProbe: async () => undefined,
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

  it("redacts provider credentials from a thrown ACP turn error before it propagates", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
    const apiKey = "codex-acp-error-secret-do-not-leak";
    process.env.CODEX_ACP_COMMAND = process.execPath;
    process.env.CODEX_ACP_ARGS = `${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} ${fakeAgent}`;
    await verifyProviderApiKey("codex", {
      env: { CODEX_API_KEY: apiKey },
      codexAcpProbe: async () => undefined,
    });
    try {
      let caught: (Error & { data?: { additionalDetails?: string } }) | undefined;
      try {
        await runTurn({
          prompt: "THROW_CREDENTIAL_ERROR",
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
          chatId: `acp-error-redact-${Date.now()}`,
          contextEnv: { CODEX_API_KEY: apiKey },
        }, { conversationId: "conv-error-redact", runId: "run-error-redact" });
      } catch (error) {
        caught = error as Error & { data?: { additionalDetails?: string } };
      }
      expect(caught).toBeDefined();
      expect(caught?.message).not.toContain(apiKey);
      expect(JSON.stringify(caught?.data ?? {})).not.toContain(apiKey);
      expect(JSON.stringify(caught?.data ?? {})).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
      expect(caught?.data?.additionalDetails).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
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

  it("fails closed quickly when codex-acp is not installed, without falling back to legacy codex exec", async () => {
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    process.env.CODEX_ACP_COMMAND = "agent-bridge-test-nonexistent-codex-acp-binary";
    const startedAt = Date.now();
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
        timeoutMs: 8_000,
        idleTimeoutMs: 8_000,
        chatId: `acp-missing-${Date.now()}`,
      }, { conversationId: "conv-missing", runId: "run-missing" }))
        // codexAcpRuntime.runTurn() has no fallback path to legacy codex
        // exec, so calling it directly and observing any rejection already
        // proves "no silent fallback". Which async path first observes the
        // spawn failure — the child "error" event, the ACP SDK's own
        // closed-stream detection, or a downstream EPIPE from a dead stdin
        // pipe — is scheduler-dependent and varies by environment; all are
        // legitimate fail-closed outcomes, so the exact message is not the
        // invariant under test here.
        .rejects.toThrow();
      // A missing adapter is a spawn-time failure, not a hard/idle timeout —
      // it must not silently wait out the full timeout window either.
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
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
    const previousCommand = process.env.CODEX_ACP_COMMAND;
    const previousArgs = process.env.CODEX_ACP_ARGS;
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
      if (previousCommand === undefined) delete process.env.CODEX_ACP_COMMAND;
      else process.env.CODEX_ACP_COMMAND = previousCommand;
      if (previousArgs === undefined) delete process.env.CODEX_ACP_ARGS;
      else process.env.CODEX_ACP_ARGS = previousArgs;
    }
  }, 15_000);
});
