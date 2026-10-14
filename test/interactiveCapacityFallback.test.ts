import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  getUserCliPreference,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { listRunContinuations, scanRunContinuations } from "../src/runContinuation.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import { combineCapacityRetryOpportunities } from "../src/providers/capacityRetryTiming.js";

// Claude (and, by shared ACP transport, Codex) resolve to ACP-stdio, which
// engine.ts drives through exec.runProviderInvocation rather than
// exec.runCli/runCliAsync. Adapt the existing native-shaped runCli fakes so
// each engine's injected fake still governs its own simulated CLI regardless
// of transport. Streamed answer-preview text flows through the
// provider-neutral onAnswerDelta callback under ACP (not the legacy native
// onProviderOutputChunk stream_event/content_block_delta shape), so bridge
// the fakes' existing stream_event chunks into onAnswerDelta here.
function extractStreamDeltaText(chunk: string): string | null {
  try {
    const obj = JSON.parse(chunk.trim());
    return obj?.event?.delta?.text ?? null;
  } catch {
    return null;
  }
}

function extractResultText(stdout: string): string {
  try {
    const obj = JSON.parse(stdout);
    if (typeof obj?.result === "string") return obj.result;
  } catch {
    // not JSON — use the raw stdout as-is.
  }
  return stdout;
}

function asAcpAdapter(runCli: any) {
  return async (_bot: string, invocation: any, cwd: string, options: any) => {
    const bridgedOptions = {
      ...options,
      onProviderOutputChunk: (chunk: string) => {
        options.onProviderOutputChunk?.(chunk);
        const delta = extractStreamDeltaText(chunk);
        if (delta) options.onAnswerDelta?.(delta);
      },
    };
    const stdout = await runCli(invocation.command, invocation.args, cwd, bridgedOptions);
    return { text: extractResultText(stdout) };
  };
}

function makeMockClient() {
  return {
    capabilities: TELEGRAM_SURFACE_CAPABILITIES,
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

describe("interactive capacity fallback durable admission", () => {
  it("holds the original admission and creates one durable wait after every allowed provider is full", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive", () => true);
    const fallbackRequests = new Map<string, import("../src/engine.js").ProviderFallbackReason>();
    const capacityFallbackAttempts = new Map<string, { runId: string; chatId: number | string; chatType: string; threadId?: number | string }>();
    const notifications: string[] = [];
    const codexRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
    const makeEngine = (kind: "codex" | "claude", runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1_000,
        hooks: {
          onProviderFallbackRequested: async (chatKey, reason, context) => {
            fallbackRequests.set(chatKey, reason);
            if (reason === "capacity" && context) capacityFallbackAttempts.set(chatKey, context);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { codex: makeEngine("codex", codexRun), claude: makeEngine("claude", claudeRun) };
    const deps = {
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");
      await dispatchInteractiveWithFallback({
        update_id: 10_100,
        message: {
          message_id: 101,
          chat: { id: 100, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "keep this exact request",
        },
      }, "100", deps);

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(db.dequeueMsgs("telegram:interactive", "100")).toEqual([
        expect.objectContaining({ prompt: "keep this exact request", chatId: 100, chatType: "private" }),
      ]);
      expect(notifications).toEqual([
        "All available providers are temporarily at capacity. I’ll retry automatically and continue your task when one becomes available.",
      ]);
      expect(listRunContinuations(db, "telegram:interactive")).toEqual([
        expect.objectContaining({ state: "pending", capacityWait: true, provider: "claude" }),
      ]);
      expect(await engines.codex.recoverPendingQueue("100")).toBe(true);
      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("suppresses terminal error output when an abandoned Claude preview cannot be deleted", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    client.deleteMessage.mockRejectedValue(new Error("Telegram delete failed"));
    const fallbackChain = new ProviderFallbackChain(["claude", "antigravity"], db, "telegram:interactive",
         () => true);
    const notifications: string[] = [];
    const claudeRun = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "stale Claude preview" } } })}\n`);
      throw new Error("rate limit capacity exhausted");
    });
    const codexRun = vi.fn().mockResolvedValue([
      JSON.stringify({ type: "thread.started", thread_id: "must-not-run" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "must not be published" } }),
    ].join("\n"));
    const makeEngine = (kind: "claude" | "codex", runCli: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
      },
      db,
      client,
      { runCli, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const deps = { engines, fallbackChain, exhaustedChats, db, notify: async (message: string) => { notifications.push(message); } };

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "claude");
      for (const engine of Object.values(engines)) {
        engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      await dispatchInteractiveWithFallback({
        update_id: 9098,
        message: { message_id: 86, chat: { id: 100, type: "private" }, from: { id: 42, first_name: "Test" }, text: "answer this" },
      }, "100", deps);

      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(codexRun).not.toHaveBeenCalled();
      expect(client.sendMessage).toHaveBeenCalledTimes(1);
      expect(client.sendMessage.mock.calls[0][0].text).toContain("stale Claude preview");
      expect(notifications).toEqual([]);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("removes an abandoned Claude answer preview before publishing the fallback answer", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["claude", "antigravity"], db, "telegram:interactive",
         () => true);
    const notifications: string[] = [];
    const claudeRun = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "stale Claude preview" } } })}\n`);
      throw new Error("rate limit capacity exhausted");
    });
    const codexRun = vi.fn().mockResolvedValue(JSON.stringify({ event: "result", result: { conversation_id: "11111111-2222-4333-8444-555555555555", status: "SUCCESS", response: "authoritative Agy fallback" } }));
    const makeEngine = (kind: "claude" | "antigravity", runCli: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
      },
      db,
      client,
      { runCli, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { claude: makeEngine("claude", claudeRun), antigravity: makeEngine("antigravity", codexRun) };
    const deps = { engines, fallbackChain, exhaustedChats, db, notify: async (message: string) => { notifications.push(message); } };

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "claude");
      for (const engine of Object.values(engines)) {
        engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      await dispatchInteractiveWithFallback({
        update_id: 9099,
        message: { message_id: 87, chat: { id: 100, type: "private" }, from: { id: 42, first_name: "Test" }, text: "answer this" },
      }, "100", deps);

      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(client.deleteMessage).toHaveBeenCalledWith({ chat_id: 100, message_id: 1 });
      expect(client.sendMessage.mock.calls.map(([body]: [any]) => body?.text)).toEqual([
        expect.stringContaining("stale Claude preview"),
        expect.stringContaining("authoritative Agy fallback"),
      ]);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(notifications).toEqual(["Switching to antigravity (claude at capacity)"]);
    } finally {
      db.close();
    }
  });

  it("continues one admitted turn across exhausted CLIs without replaying the Telegram update", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, "telegram:interactive",
         () => true);
    const notifications: string[] = [];

    const codexRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const antigravityRun = vi.fn().mockResolvedValue(JSON.stringify({
      type: "result",
      session_id: "fallback-success-session",
      result: "opened the PR",
    }));

    const makeEngine = (runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        // Use one parser contract for all three keyed engines; this test is about
        // interactive admission/fallback ownership, not provider output parsing.
        kind: "claude",
        botConfig: { command: "claude", modelPreference: ["test-model"] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        hooks: {
          onCapacityExhausted: async (chatKey: string) => {
            exhaustedChats.add(chatKey);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );

    const engines = {
      codex: makeEngine(codexRun),
      claude: makeEngine(claudeRun),
      antigravity: makeEngine(antigravityRun as any),
    };
    const deps = {
      engines,
      fallbackChain,
      exhaustedChats,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    // Production wires every engine's claimed queue rows back through the
    // shared interactive fallback owner. Keep that boundary in the regression.
    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) =>
        dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");
      // An unrelated pending lane on the same surface must not be recovered as
      // a side effect of chat 100 changing providers.
      db.enqueueMsg("telegram:interactive", "200", {
        prompt: "unrelated queued work",
        chatId: 200,
        chatType: "private",
        userId: 42,
      });

      await dispatchInteractiveWithFallback(
        {
          update_id: 9001,
          message: {
            message_id: 77,
            chat: { id: 100, type: "private" },
            from: { id: 42, first_name: "Test" },
            text: "Open a pr for review",
          },
        },
        "100",
        deps,
      );

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(antigravityRun).toHaveBeenCalledTimes(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(db.pendingMsgCount("telegram:interactive", "200")).toBe(1);
      expect(getUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" } )).toBe("antigravity");
      expect(notifications).toEqual([
        "Switching to claude (codex at capacity)",
        "Switching to antigravity (claude at capacity)",
      ]);

      const finalReplies = client.sendMessage.mock.calls
        .map(([body]: [any]) => body?.text)
        .filter((text: unknown) => text === "opened the PR");
      expect(finalReplies).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("terminally handles one admitted turn when every CLI is exhausted", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db, "telegram:interactive",
         () => true);
    const notifications: string[] = [];

    const codexRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("session limit reached"));
    const antigravityRun = vi.fn().mockRejectedValue(new Error("session limit reached"));

    const makeEngine = (runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: ["test-model"] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1000,
        hooks: {
          onCapacityExhausted: async (chatKey: string) => {
            exhaustedChats.add(chatKey);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );

    const engines = {
      codex: makeEngine(codexRun),
      claude: makeEngine(claudeRun),
      antigravity: makeEngine(antigravityRun),
    };
    const deps = {
      engines,
      fallbackChain,
      exhaustedChats,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) =>
        dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");

      await dispatchInteractiveWithFallback(
        {
          update_id: 9002,
          message: {
            message_id: 78,
            chat: { id: 100, type: "private" },
            from: { id: 42, first_name: "Test" },
            text: "Open a pr for review",
          },
        },
        "100",
        deps,
      );

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(antigravityRun).toHaveBeenCalledTimes(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(getUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" } )).toBe("codex");
      expect(notifications).toEqual([
        "Switching to claude (codex at capacity)",
        "Switching to antigravity (claude at capacity)",
        "No remaining configured fallback provider is available. Please try again later.",
      ]);
    } finally {
      db.close();
    }
  });
  it("preserves retainedPendingMessageIds across two-provider fallback and cleans attachments on expiry", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive", () => true);
    const fallbackRequests = new Map<string, import("../src/engine.js").ProviderFallbackReason>();
    const capacityFallbackAttempts = new Map<string, { runId: string; chatId: number | string; chatType: string; threadId?: number | string }>();
    const notifications: string[] = [];
    const codexRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));

    const makeEngine = (kind: "codex" | "claude", runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1_000,
        hooks: {
          onProviderFallbackRequested: async (chatKey, reason, context) => {
            fallbackRequests.set(chatKey, reason);
            if (reason === "capacity" && context) capacityFallbackAttempts.set(chatKey, context);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { codex: makeEngine("codex", codexRun), claude: makeEngine("claude", claudeRun) };
    const deps = {
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    const uploadDir = join(tmpdir(), `bridge-uploads-fallback-${randomUUID()}`);
    mkdirSync(uploadDir, { recursive: true });
    const attachmentPath = join(uploadDir, "spec.pdf");
    writeFileSync(attachmentPath, "dummy pdf data");
    expect(existsSync(attachmentPath)).toBe(true);

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");
      db.enqueueMsg("telegram:interactive", "100", {
        prompt: "review this file",
        chatId: 100,
        chatType: "private",
        userId: 42,
        attachments: [attachmentPath],
      });
      const handle = db.acquireLock("telegram:interactive", "100");
      expect(handle).not.toBeNull();
      const claimedMsg = db.claimNextPendingMsg(handle!);
      expect(claimedMsg).not.toBeNull();
      expect(claimedMsg!.attachments).toEqual([attachmentPath]);

      // Dispatch as claimed message across the two-provider fallback:
      const outcome = await dispatchClaimedInteractiveWithFallback(
        { ...claimedMsg!, laneHandle: handle!, laneLifecycleManaged: true },
        "100",
        deps,
      );
      expect(outcome).toBe("deferred");

      for (const id of claimedMsg!.pendingIds ?? [claimedMsg!.id]) {
        db.releasePendingClaim(handle!, id);
      }
      db.unlock(handle!);

      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(claudeRun).toHaveBeenCalledTimes(1);

      const continuations = listRunContinuations(db, "telegram:interactive");
      expect(continuations).toHaveLength(1);
      const continuation = continuations[0];
      expect(continuation.capacityWait).toBe(true);
      expect(continuation.retainedPendingMessageIds).toEqual([claimedMsg!.id]);

      // Now simulate expiry:
      const expiredNotice: string[] = [];
      const onCapacityExpired = async (c: any) => {
        const ids = c.retainedPendingMessageIds ?? [];
        if (!ids.length || !db.retireQueuedPendingMsgs(c.surfaceIdentity, c.chatKey, ids)) return;
        expiredNotice.push("I could not retry your task before the provider recovery window expired.");
      };

      await scanRunContinuations(db, "telegram:interactive", vi.fn(), Date.parse(continuation.expiresAt), { onCapacityExpired });

      expect(expiredNotice).toHaveLength(1);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(existsSync(attachmentPath)).toBe(false);
      expect(existsSync(uploadDir)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("cancels pending and claimed capacity waits when user sends /stop", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, "telegram:interactive", () => true);
    const fallbackRequests = new Map<string, import("../src/engine.js").ProviderFallbackReason>();
    const capacityFallbackAttempts = new Map<string, { runId: string; chatId: number | string; chatType: string; threadId?: number | string }>();
    const notifications: string[] = [];
    const codexRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
    const claudeRun = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));

    const makeEngine = (kind: "codex" | "claude", runCli: typeof codexRun) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        pollIntervalMs: 1_000,
        hooks: {
          onProviderFallbackRequested: async (chatKey, reason, context) => {
            fallbackRequests.set(chatKey, reason);
            if (reason === "capacity" && context) capacityFallbackAttempts.set(chatKey, context);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any, runProviderInvocation: asAcpAdapter(runCli) },
    );
    const engines = { codex: makeEngine("codex", codexRun), claude: makeEngine("claude", claudeRun) };
    const deps = {
      engines,
      fallbackChain,
      fallbackRequests,
      capacityFallbackAttempts,
      db,
      notify: async (message: string) => { notifications.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");
      await dispatchInteractiveWithFallback({
        update_id: 11_000,
        message: {
          message_id: 201,
          chat: { id: 100, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "long running prompt",
        },
      }, "100", deps);

      expect(listRunContinuations(db, "telegram:interactive")[0].state).toBe("pending");
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(1);

      // Now send /stop:
      await engines.codex.handleUpdate({
        update_id: 11_001,
        message: {
          message_id: 202,
          chat: { id: 100, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "/stop",
        },
      });

      // The continuation must be cancelled:
      expect(listRunContinuations(db, "telegram:interactive")[0].state).toBe("cancelled");
      // The pending messages must be discarded:
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);

      // Subsequent scan does not dispatch:
      const dispatch = vi.fn();
      await scanRunContinuations(db, "telegram:interactive", dispatch, Date.now() + 600_000);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it("combines mixed provider retry timing across attempt orders to preserve bounded 300s unknown timing", async () => {
    for (const order of [["codex", "claude"], ["claude", "codex"]] as const) {
      const db = openDb(":memory:");
      const client = makeMockClient();
      const fallbackChain = new ProviderFallbackChain([...order], db, "telegram:interactive", () => true);
      const fallbackRequests = new Map<string, any>();
      const capacityFallbackAttempts = new Map<string, any>();
      const notifications: string[] = [];

      const makeEngine = (kind: "codex" | "claude", error: Error) => new BridgeEngine(
        {
          surfaceIdentity: "telegram:interactive",
          kind,
          botConfig: { command: kind, modelPreference: [] },
          allowedUserIds: new Set(["42"]),
          executionMode: "safe",
          busyMessageMode: "augment",
          pollIntervalMs: 1_000,
          hooks: {
            onProviderFallbackRequested: async (chatKey, reason, context) => {
              fallbackRequests.set(chatKey, reason);
              if (reason === "capacity" && context) {
                const previous = capacityFallbackAttempts.get(chatKey);
                const retryAfter = kind === "codex" ? 7200 : undefined;
                const combined = combineCapacityRetryOpportunities(previous, {
                  ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
                  ...(retryAfter === undefined ? { hasUnknownCapacityTiming: true } : {}),
                });
                capacityFallbackAttempts.set(chatKey, {
                  ...context,
                  provider: kind,
                  retryAfterSeconds: combined.retryAfterSeconds,
                  ...(combined.hasUnknownCapacityTiming ? { hasUnknownCapacityTiming: true as const } : {}),
                });
              }
            },
          },
        },
        db,
        client,
        {
          runCli: vi.fn().mockRejectedValue(error) as any,
          runProviderInvocation: asAcpAdapter(vi.fn().mockRejectedValue(error)),
        },
      );

      const codexError = new Error("MODEL_CAPACITY_EXHAUSTED");
      const claudeError = new Error("MODEL_CAPACITY_EXHAUSTED");
      const engines = {
        codex: makeEngine("codex", codexError),
        claude: makeEngine("claude", claudeError),
      };

      const deps = {
        engines,
        fallbackChain,
        fallbackRequests,
        capacityFallbackAttempts,
        db,
        notify: async (msg: string) => { notifications.push(msg); },
        onCliSwitched: async (cli: any) => setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, cli),
      };

      for (const engine of Object.values(engines)) {
        engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      try {
        setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: "100" }, order[0]);
        const outcome = await dispatchInteractiveWithFallback({
          update_id: 1,
          message: {
            message_id: 101,
            chat: { id: 100, type: "private" },
            from: { id: 42, first_name: "Test" },
            text: "do research",
          },
        }, "100", deps);

        expect(outcome).toBe("queued");
        const continuations = listRunContinuations(db, "telegram:interactive");
        expect(continuations).toHaveLength(1);
        const continuation = continuations[0];
        // Must be scheduled for 300s, not 7200s:
        const scheduledDelaySeconds = Math.round((Date.parse(continuation.dueAt) - Date.parse(continuation.requestedAt)) / 1000);
        expect(scheduledDelaySeconds).toBe(300);

        // Must emit the generic automatic retry notice (since timing is unknown):
        expect(notifications).toContain("All available providers are temporarily at capacity. I’ll retry automatically and continue your task when one becomes available.");
      } finally {
        db.close();
      }
    }
  });
});
