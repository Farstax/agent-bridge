/**
 * Phase 1 — BridgeEvent types and RunView reducer (green).
 * Phase 2 — Event emission from runCliAsync (red until implementation).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect, vi } from "vitest";

const cliTestCwd = mkdtempSync(join(tmpdir(), "agent-bridge-event-tests-"));
afterAll(() => rmSync(cliTestCwd, { recursive: true, force: true }));

// ── Type contract ─────────────────────────────────────────────────────────────

describe("BridgeEvent type contract", () => {
  it("RunStartedEvent has required fields", async () => {
    const { type } = await import("../src/events/types.js");
    const event: ReturnType<typeof type.runStarted> = type.runStarted({
      runId: "r-1",
      bot: "claude",
      chatId: "100",
      command: "claude",
      cwd: "/home/user",
      model: "claude-sonnet-4-6",
    });
    expect(event.type).toBe("run.started");
    expect(event.version).toBe(1);
    expect(event.runId).toBe("r-1");
    expect(event.bot).toBe("claude");
    expect(event.chatId).toBe("100");
    expect(event.command).toBe("claude");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it("TextDeltaEvent carries text and source", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.textDelta({ runId: "r-1", bot: "claude", chatId: "100", text: "hello", source: "stdout" });
    expect(event.type).toBe("text.delta");
    expect(event.text).toBe("hello");
    expect(event.source).toBe("stdout");
  });

  it("RunCompletedEvent carries final text and sessionId", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runCompleted({ runId: "r-1", bot: "claude", chatId: "100", text: "done", sessionId: "s-1" });
    expect(event.type).toBe("run.completed");
    expect(event.text).toBe("done");
    expect(event.sessionId).toBe("s-1");
  });

  it("RunFailedEvent carries error string and category", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runFailed({ runId: "r-1", bot: "claude", chatId: "100", error: "timeout", category: "timeout" });
    expect(event.type).toBe("run.failed");
    expect(event.error).toBe("timeout");
    expect(event.category).toBe("timeout");
  });

  it("RunCancelledEvent carries reason", async () => {
    const { type } = await import("../src/events/types.js");
    const event = type.runCancelled({ runId: "r-1", bot: "claude", chatId: "100", reason: "user" });
    expect(event.type).toBe("run.cancelled");
    expect(event.reason).toBe("user");
  });

  it("each event gets a unique id", async () => {
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const a = type.textDelta({ ...base, text: "a", source: "stdout" as const });
    const b = type.textDelta({ ...base, text: "b", source: "stdout" as const });
    expect(a.id).not.toBe(b.id);
  });
});

// ── RunView reducer ───────────────────────────────────────────────────────────

describe("RunView reducer", () => {
  it("starts in idle state with empty events", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const view = reduce([]);
    expect(view.status).toBe("idle");
    expect(view.text).toBe("");
  });

  it("run.started sets status to running", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const view = reduce([
      type.runStarted({ runId: "r-1", bot: "claude", chatId: "100", command: "claude", cwd: "/", model: null }),
    ]);
    expect(view.status).toBe("running");
    expect(view.runId).toBe("r-1");
  });

  it("text.delta events are appended in order", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "Hello ", source: "stdout" }),
      type.textDelta({ ...base, text: "world", source: "stdout" }),
    ]);
    expect(view.text).toBe("Hello world");
    expect(view.status).toBe("running");
  });

  it("run.completed sets final text, sessionId, and status done", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "interim ", source: "stdout" }),
      type.runCompleted({ ...base, text: "Final answer", sessionId: "s-99" }),
    ]);
    expect(view.status).toBe("done");
    expect(view.text).toBe("Final answer");
    expect(view.sessionId).toBe("s-99");
  });

  it("run.completed overrides accumulated delta text with authoritative final text", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "codex" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "codex", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "partial delta", source: "stdout" }),
      type.runCompleted({ ...base, text: "Authoritative final", sessionId: null }),
    ]);
    expect(view.text).toBe("Authoritative final");
  });

  it("run.failed stores error and sets status failed", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runFailed({ ...base, error: "CLI hard timeout after 1800000ms", category: "timeout" }),
    ]);
    expect(view.status).toBe("failed");
    expect(view.error).toContain("timeout");
  });

  it("run.cancelled sets status cancelled", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runCancelled({ ...base, reason: "user" }),
    ]);
    expect(view.status).toBe("cancelled");
  });

  it("updatedAt advances with each event", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "claude" as const, chatId: "100" };
    const v1 = reduce([type.runStarted({ ...base, command: "claude", cwd: "/", model: null })]);
    // Small delay to ensure timestamps differ
    await new Promise(r => setTimeout(r, 5));
    const v2 = reduce([
      type.runStarted({ ...base, command: "claude", cwd: "/", model: null }),
      type.runCompleted({ ...base, text: "done", sessionId: null }),
    ]);
    expect(new Date(v2.updatedAt) >= new Date(v1.updatedAt)).toBe(true);
  });

  it("acp.event does not change delivered text/status — Telegram/Discord never redeliver it", async () => {
    const { reduce } = await import("../src/events/reducer.js");
    const { type } = await import("../src/events/types.js");
    const base = { runId: "r-1", bot: "codex" as const, chatId: "100", chatKey: "100" };
    const view = reduce([
      type.runStarted({ ...base, command: "codex", cwd: "/", model: null }),
      type.textDelta({ ...base, text: "live answer", source: "stdout" }),
      type.acpEvent({
        ...base,
        sessionMode: "load",
        event: { kind: "session_update", channel: "replay", notification: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed history" } } } },
      }),
      type.runCompleted({ ...base, text: "live answer", sessionId: "s-1" }),
    ]);
    expect(view.text).toBe("live answer");
    expect(view.text).not.toContain("replayed history");
    expect(view.status).toBe("done");
  });
});

// ── Phase 2: Event emission from runCliAsync ──────────────────────────────────

describe("runCliAsync — event emission", () => {
  const eventCtx = { runId: "r-test", bot: "claude" as const, chatId: "test-99" };

  it("emits run.started then text.delta then run.completed for a successful command", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const events: any[] = [];
    await runCliAsync("node", ["-e", "process.stdout.write('hello')"], cliTestCwd, {
      eventContext: eventCtx,
      onEvent: (e) => events.push(e),
    });
    const types = events.map(e => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("text.delta");
    expect(types).toContain("run.completed");
    const started = events.findIndex(e => e.type === "run.started");
    const delta = events.findIndex(e => e.type === "text.delta");
    const completed = events.findIndex(e => e.type === "run.completed");
    expect(started).toBeLessThan(delta);
    expect(delta).toBeLessThan(completed);
  });

  it("logs structured events to the console", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCliAsync("node", ["-e", "process.stdout.write('hello')"], cliTestCwd, {
      eventContext: eventCtx,
      onEvent: () => {},
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[event] run.started runId=r-test bot=claude chatId=test-99"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[event] run.completed runId=r-test"));
    logSpy.mockRestore();
  });

  it("text.delta events carry the stdout chunk text", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const deltas: string[] = [];
    await runCliAsync("node", ["-e", "process.stdout.write('ping')"], cliTestCwd, {
      eventContext: eventCtx,
      onEvent: (e) => { if (e.type === "text.delta") deltas.push(e.text); },
    });
    expect(deltas.join("")).toContain("ping");
  });

  it("run.completed carries the full stdout text", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const events: any[] = [];
    await runCliAsync("node", ["-e", "process.stdout.write('final')"], cliTestCwd, {
      eventContext: eventCtx,
      onEvent: (e) => events.push(e),
    });
    const completed = events.find(e => e.type === "run.completed");
    expect(completed?.text).toContain("final");
  });

  it("emits run.failed with category=cli when process exits non-zero", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const events: any[] = [];
    await runCliAsync("node", ["-e", "process.exit(1)"], cliTestCwd, {
      eventContext: eventCtx,
      onEvent: (e) => events.push(e),
    }).catch(() => {});
    const failed = events.find(e => e.type === "run.failed");
    expect(failed).toBeDefined();
    expect(failed?.category).toBe("cli");
  });

  it("emits run.failed with category=timeout on idle timeout", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    const events: any[] = [];
    await runCliAsync("node", ["-e", "setTimeout(()=>{},30000)"], cliTestCwd, {
      eventContext: eventCtx,
      idleTimeoutMs: 100,
      onEvent: (e) => events.push(e),
    }).catch(() => {});
    const failed = events.find(e => e.type === "run.failed");
    expect(failed).toBeDefined();
    expect(failed?.category).toBe("timeout");
  });

  it("emits run.cancelled when process is aborted", async () => {
    const { runCliAsync, abortCliProcess } = await import("../src/cli.js");
    const events: any[] = [];
    const runPromise = runCliAsync("node", ["-e", "setTimeout(()=>{},30000)"], cliTestCwd, {
      chatId: "abort-test-phase2",
      eventContext: { ...eventCtx, runId: "r-abort" },
      onEvent: (e) => events.push(e),
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 50));
    abortCliProcess("abort-test-phase2");
    await runPromise;
    const cancelled = events.find(e => e.type === "run.cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled?.reason).toBe("user");
  });

  it("does not emit events when onEvent is not provided (no-op)", async () => {
    const { runCliAsync } = await import("../src/cli.js");
    // Should not throw even when eventContext is absent
    await expect(
      runCliAsync("node", ["-e", "process.stdout.write('ok')"], cliTestCwd, {})
    ).resolves.toBeDefined();
  });

  it("event base fields carry the runId, bot, and chatId from eventContext", async () => {
    // (Phase 3 tests follow this describe block)
    const { runCliAsync } = await import("../src/cli.js");
    const events: any[] = [];
    const ctx = { runId: "my-run-id", bot: "codex" as const, chatId: "chat-42" };
    await runCliAsync("node", ["-e", "process.stdout.write('x')"], cliTestCwd, {
      eventContext: ctx,
      onEvent: (e) => events.push(e),
    });
    for (const e of events) {
      expect(e.runId).toBe("my-run-id");
      expect(e.bot).toBe("codex");
      expect(e.chatId).toBe("chat-42");
      expect(e.version).toBe(1);
    }
  });
});

// ── Phase 3: Telegram parity adapter ─────────────────────────────────────────

describe("runViewToTelegramText — parity adapter", () => {
  it("returns final text for a completed run", async () => {
    const { runViewToTelegramText } = await import("../src/events/telegramAdapter.js");
    expect(runViewToTelegramText({ runId: "r", status: "done", text: "Hello world", updatedAt: "" }))
      .toBe("Hello world");
  });

  it("returns error text prefixed with ❌ for a failed run", async () => {
    const { runViewToTelegramText } = await import("../src/events/telegramAdapter.js");
    const result = runViewToTelegramText({ runId: "r", status: "failed", text: "", error: "timeout", updatedAt: "" });
    expect(result).toContain("❌");
    expect(result).toContain("timeout");
  });

  it("returns a cancellation notice for a cancelled run", async () => {
    const { runViewToTelegramText } = await import("../src/events/telegramAdapter.js");
    const result = runViewToTelegramText({ runId: "r", status: "cancelled", text: "", updatedAt: "" });
    expect(result.length).toBeGreaterThan(0);
  });

  it("passes text through toTelegramEntitiesText — code blocks become pre entities", async () => {
    const { runViewToTelegramText } = await import("../src/events/telegramAdapter.js");
    const { toTelegramEntitiesText } = await import("../src/render.js");
    const codeText = "```js\nconsole.log('hi')\n```";
    const adapterResult = runViewToTelegramText({ runId: "r", status: "done", text: codeText, updatedAt: "" });
    const directResult = toTelegramEntitiesText(codeText);
    // Both should produce the same entity-encoded text
    expect(adapterResult).toBe(directResult.text);
  });

  it("long text is split into chunks via splitTelegramText — each chunk within limit", async () => {
    const { runViewToTelegramChunks } = await import("../src/events/telegramAdapter.js");
    const longText = "word ".repeat(1000).trim();
    const chunks = runViewToTelegramChunks({ runId: "r", status: "done", text: longText, updatedAt: "" });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3500);
    }
  });

  it("returns single-element array for short text", async () => {
    const { runViewToTelegramChunks } = await import("../src/events/telegramAdapter.js");
    const chunks = runViewToTelegramChunks({ runId: "r", status: "done", text: "Short answer", updatedAt: "" });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short answer");
  });
});
