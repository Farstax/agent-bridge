import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveWithFallback,
  getUserCliPreference,
  setUserCliPreference,
} from "../src/interactiveBot.js";

function makeMockClient() {
  return {
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
  it("suppresses terminal error output when an abandoned Claude preview cannot be deleted", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    client.deleteMessage.mockRejectedValue(new Error("Telegram delete failed"));
    const fallbackChain = new ProviderFallbackChain(["claude", "codex"], db);
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
        asyncEnabled: false,
        pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
      },
      db,
      client,
      { runCli },
    );
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const deps = { engines, fallbackChain, exhaustedChats, db, notify: async (message: string) => { notifications.push(message); } };

    try {
      setUserCliPreference(db, "100", "claude");
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
    const fallbackChain = new ProviderFallbackChain(["claude", "codex"], db);
    const notifications: string[] = [];
    const claudeRun = vi.fn().mockImplementation(async (_cmd: string, _args: string[], _cwd: string, options: any) => {
      options.onProviderOutputChunk?.(`${JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "stale Claude preview" } } })}\n`);
      throw new Error("rate limit capacity exhausted");
    });
    const codexRun = vi.fn().mockResolvedValue([
      JSON.stringify({ type: "thread.started", thread_id: "codex-fallback-session" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "authoritative Codex fallback" } }),
    ].join("\n"));
    const makeEngine = (kind: "claude" | "codex", runCli: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        asyncEnabled: false,
        pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
      },
      db,
      client,
      { runCli },
    );
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const deps = { engines, fallbackChain, exhaustedChats, db, notify: async (message: string) => { notifications.push(message); } };

    try {
      setUserCliPreference(db, "100", "claude");
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
        expect.stringContaining("authoritative Codex fallback"),
      ]);
      expect(client.sendMessage).toHaveBeenCalledTimes(2);
      expect(notifications).toEqual(["Switching to codex (claude at capacity)"]);
    } finally {
      db.close();
    }
  });

  it("recovers a Claude continuation through a fresh Codex session without replaying or double-closing the turn", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["claude", "codex"], db);
    const notifications: string[] = [];
    let providerWork: "live" | "absent" = "live";
    const claudeRun = vi.fn()
      .mockResolvedValueOnce({ text: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "tool-bg", name: "Bash", input: { run_in_background: true } }] },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "Claude started background work.", session_id: "claude-native-session" }),
      ].join("\n") })
      .mockRejectedValueOnce(new Error("rate limit"));
    const codexRun = vi.fn().mockResolvedValue({
      text: [
        JSON.stringify({ type: "thread.started", thread_id: "codex-fresh-session" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex completed the request." } }),
      ].join("\n"),
    });

    const makeEngine = (kind: "claude" | "codex", runCliAsync: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive",
        kind,
        botConfig: { command: kind, modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        busyMessageMode: "augment",
        asyncEnabled: true,
        pollIntervalMs: 1000,
        hooks: kind === "claude" ? {
          onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); },
        } : undefined,
      },
      db,
      client,
      { runCliAsync },
      {
        hasLiveRunOwnedDescendants: vi.fn(() => providerWork === "live"),
        getRunOwnedProcessState: vi.fn(() => providerWork === "live" ? "live" : "absent"),
        killRunOwnedDescendants: vi.fn(async () => { providerWork = "absent"; }),
        sleep: vi.fn(async () => { providerWork = "absent"; }),
      },
    );

    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
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
      setUserCliPreference(db, "100", "claude");
      await dispatchInteractiveWithFallback(
        {
          update_id: 9100,
          message: {
            message_id: 88,
            chat: { id: 100, type: "private" },
            from: { id: 42, first_name: "Test" },
            text: "finish the background task",
          },
        },
        "100",
        deps,
      );

      expect(claudeRun).toHaveBeenCalledTimes(2);
      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(codexRun.mock.calls[0][3]).not.toEqual(expect.objectContaining({ sessionId: "claude-native-session" }));
      expect(notifications).toEqual(["Switching to codex (claude at capacity)"]);
      expect(client.sendMessage.mock.calls.map(([body]: [any]) => body?.text)).toEqual([
        "Claude started background work.",
        "Codex completed the request.",
      ]);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      const runId = claudeRun.mock.calls[0][3].eventContext.runId;
      expect(new ContinuationRepository(db.raw).get(runId)?.state).toBe("cancelled");
      // A result from the fenced Claude tree cannot trigger another provider
      // call or another terminal user-visible closure.
      expect(claudeRun).toHaveBeenCalledTimes(2);
    } finally {
      db.close();
    }
  });

  it("emits one concrete blocker when the fallback provider cannot recover a Claude continuation", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["claude", "codex"], db);
    const notifications: string[] = [];
    let providerWork: "live" | "absent" = "live";
    const claudeRun = vi.fn()
      .mockResolvedValueOnce({ text: [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-bg-2", name: "Bash", input: { run_in_background: true } }] } }),
        JSON.stringify({ type: "result", subtype: "success", result: "Claude started background work.", session_id: "claude-native-session-2" }),
      ].join("\n") })
      .mockRejectedValueOnce(new Error("rate limit"));
    const codexRun = vi.fn().mockRejectedValue(new Error("rate limit"));
    const makeEngine = (kind: "claude" | "codex", runCliAsync: any) => new BridgeEngine(
      {
        surfaceIdentity: "telegram:interactive", kind,
        botConfig: { command: kind, modelPreference: [] }, allowedUserIds: new Set(["42"]),
        executionMode: "safe", busyMessageMode: "augment", asyncEnabled: true, pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
      }, db, client, { runCliAsync },
      {
        hasLiveRunOwnedDescendants: vi.fn(() => providerWork === "live"),
        getRunOwnedProcessState: vi.fn(() => providerWork === "live" ? "live" : "absent"),
        killRunOwnedDescendants: vi.fn(async () => { providerWork = "absent"; }),
        sleep: vi.fn(async () => { providerWork = "absent"; }),
      },
    );
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const deps = { engines, fallbackChain, exhaustedChats, db, notify: async (message: string) => { notifications.push(message); } };
    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, "100", "claude");
      await dispatchInteractiveWithFallback({
        update_id: 9101,
        message: { message_id: 89, chat: { id: 100, type: "private" }, from: { id: 42, first_name: "Test" }, text: "finish the background task" },
      }, "100", deps);

      expect(claudeRun).toHaveBeenCalledTimes(2);
      expect(codexRun).toHaveBeenCalledTimes(1);
      expect(notifications).toEqual(["Switching to codex (claude at capacity)", "All CLIs are currently unavailable. Please try again later."]);
      expect(client.sendMessage.mock.calls.map(([body]: [any]) => body?.text)).toEqual([
        "Claude started background work.",
      ]);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
    } finally {
      db.close();
    }
  });

  it("fails closed when Claude descendants remain live or ambiguous during fallback handoff", async () => {
    const db = openDb(":memory:");
    const client = makeMockClient();
    const runId = "continuation-containment-blocker";
    db.insertRun(runId, "100", "claude");
    new ContinuationRepository(db.raw).saveWaiting({
      runId,
      surface: "telegram:interactive",
      chatKey: "100",
      chatId: 100,
      threadId: null,
      bot: "claude",
      sessionId: "claude-native-session-3",
      prompt: "finish the background task",
      chatType: "private",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: runId,
      resumptionCount: 1,
      pendingIds: [],
      startedAt: new Date(Date.now() - 1000).toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const kill = vi.fn().mockRejectedValueOnce(new Error("containment probe failed"));
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude",
      botConfig: { command: "claude", modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
    }, db, client, { runCliAsync: vi.fn() }, {
      hasLiveRunOwnedDescendants: () => true,
      getRunOwnedProcessState: () => "live",
      killRunOwnedDescendants: kill,
      sleep: vi.fn(async () => {}),
    });

    try {
      await expect(engine.handoffActiveContinuationForFallback("100")).resolves.toBe("blocked");
      expect(kill).toHaveBeenCalledWith(runId);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(client.sendMessage.mock.calls.map(([body]: [any]) => body?.text)).toEqual([
        "Background continuation could not be safely handed to another provider because the original provider work could not be contained. Please try again later.",
      ]);
    } finally {
      db.close();
    }
  });

  it("continues one admitted turn across exhausted CLIs without replaying the Telegram update", async () => {
    const db = openDb(":memory:");
    const exhaustedChats = new Set<string>();
    const client = makeMockClient();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db);
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
        asyncEnabled: false,
        pollIntervalMs: 1000,
        hooks: {
          onCapacityExhausted: async (chatKey: string) => {
            exhaustedChats.add(chatKey);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any },
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
      setUserCliPreference(db, "100", "codex");
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
      expect(getUserCliPreference(db, "100")).toBe("antigravity");
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
    const fallbackChain = new ProviderFallbackChain(["codex", "claude", "antigravity"], db);
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
        asyncEnabled: false,
        pollIntervalMs: 1000,
        hooks: {
          onCapacityExhausted: async (chatKey: string) => {
            exhaustedChats.add(chatKey);
          },
        },
      },
      db,
      client,
      { runCli: runCli as any },
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
      setUserCliPreference(db, "100", "codex");

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
      expect(getUserCliPreference(db, "100")).toBe("codex");
      expect(notifications).toEqual([
        "Switching to claude (codex at capacity)",
        "Switching to antigravity (claude at capacity)",
        "All CLIs are currently unavailable. Please try again later.",
      ]);
    } finally {
      db.close();
    }
  });
});
