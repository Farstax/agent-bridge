import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ProviderFallbackReason } from "../src/engine.js";
import { ProviderStallError } from "../src/cli.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchClaimedInteractiveWithFallback, dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";

function client() {
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

describe("provider stall fallback", () => {
  it("abandons the stalled source session and continues once through a fresh fallback provider", async () => {
    const db = openDb(":memory:");
    const surface = "telegram:interactive";
    const chatKey = "858";
    const fallbackRequests = new Map<string, ProviderFallbackReason>();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, () => true);
    const telegram = client();
    const notices: string[] = [];
    const sourceRun = vi.fn(async () => {
      throw new ProviderStallError("stalled");
    });
    const targetRequests: any[] = [];
    const targetRun = vi.fn(async (
      _kind: string,
      _invocation: any,
      _cwd: string,
      _options: any,
      request: any,
    ) => {
      targetRequests.push(request);
      return { text: "authoritative fallback answer", sessionId: "claude-fresh", stopReason: "end_turn" };
    });

    const makeEngine = (kind: "codex" | "claude", runProviderInvocation: any) => new BridgeEngine({
      surfaceIdentity: surface,
      kind,
      botConfig: { command: kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      busyMessageMode: "augment",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
      hooks: {
        onProviderFallbackRequested: async (key, reason) => {
          fallbackRequests.set(key, reason);
        },
      },
    }, db, telegram, { runProviderInvocation } as any);

    const engines = {
      codex: makeEngine("codex", sourceRun),
      claude: makeEngine("claude", targetRun),
    };
    const deps = {
      engines,
      fallbackChain,
      fallbackRequests,
      db,
      notify: async (message: string) => { notices.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) =>
        dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, chatKey, "codex");
      persistProviderSession(db, chatKey, "codex", "poisoned-codex-session");
      persistProviderSession(db, chatKey, "claude", "stale-claude-session");

      await dispatchInteractiveWithFallback({
        update_id: 860,
        message: {
          message_id: 1,
          chat: { id: 858, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "finish the task",
        },
      }, chatKey, deps);

      expect(sourceRun).toHaveBeenCalledTimes(1);
      expect(targetRun).toHaveBeenCalledTimes(1);
      expect(lookupProviderSession(db, chatKey, "codex")).toBeNull();
      expect(targetRequests[0].sessionId).toBeNull();
      expect(targetRequests[0].prompt).toContain("[Agent Bridge provider fallback]");
      expect(targetRequests[0].prompt).toContain("externally observable results");
      expect(targetRequests[0].prompt).toContain("finish the task");
      expect(lookupProviderSession(db, chatKey, "claude")).toBe("claude-fresh");
      expect(notices).toEqual(["Switching to claude after codex became unavailable."]);

      const finalAnswers = telegram.sendMessage.mock.calls
        .map(([body]: [any]) => body?.text)
        .filter((text: unknown) => text === "authoritative fallback answer");
      expect(finalAnswers).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not retry a stalled provider when no fallback remains", async () => {
    const db = openDb(":memory:");
    const fallbackRequests = new Map<string, ProviderFallbackReason>();
    const fallbackChain = new ProviderFallbackChain(["codex"], db, () => true);
    const telegram = client();
    const sourceRun = vi.fn(async () => {
      throw new ProviderStallError("still stalled");
    });
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind: "codex",
      botConfig: { command: "codex", modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
      hooks: {
        onProviderFallbackRequested: async (key, reason) => {
          fallbackRequests.set(key, reason);
        },
      },
    }, db, telegram, { runProviderInvocation: sourceRun } as any);
    const notices: string[] = [];
    const deps = {
      engines: { codex: engine },
      fallbackChain,
      fallbackRequests,
      db,
      notify: async (message: string) => { notices.push(message); },
    };
    engine.setQueuedMessageHandler(async (queued) =>
      dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));

    try {
      await dispatchInteractiveWithFallback({
        update_id: 861,
        message: {
          message_id: 2,
          chat: { id: 858, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "do work",
        },
      }, "858", deps);

      expect(sourceRun).toHaveBeenCalledTimes(1);
      expect(notices).toEqual(["No remaining configured fallback provider is available. Please try again later."]);
    } finally {
      db.close();
    }
  });

  it("keeps ordinary task errors on the existing delivery path without provider fallback", async () => {
    const db = openDb(":memory:");
    const chatKey = "860";
    const fallbackRequests = new Map<string, ProviderFallbackReason>();
    const fallbackChain = new ProviderFallbackChain(["codex", "claude"], db, () => true);
    const telegram = client();
    const notices: string[] = [];
    const sourceRun = vi.fn(async () => {
      throw new Error("ordinary task failure");
    });
    const targetRun = vi.fn(async () => ({
      text: "must not run",
      sessionId: "unexpected",
      stopReason: "end_turn",
    }));

    const makeEngine = (kind: "codex" | "claude", runProviderInvocation: any) => new BridgeEngine({
      surfaceIdentity: "telegram:interactive",
      kind,
      botConfig: { command: kind, modelPreference: [] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      pollIntervalMs: 1000,
      workingDir: process.cwd(),
      hooks: {
        onProviderFallbackRequested: async (key, reason) => {
          fallbackRequests.set(key, reason);
        },
      },
    }, db, telegram, { runProviderInvocation } as any);

    const engines = {
      codex: makeEngine("codex", sourceRun),
      claude: makeEngine("claude", targetRun),
    };
    const deps = {
      engines,
      fallbackChain,
      fallbackRequests,
      db,
      notify: async (message: string) => { notices.push(message); },
    };

    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (queued) =>
        dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
    }

    try {
      setUserCliPreference(db, chatKey, "codex");
      await dispatchInteractiveWithFallback({
        update_id: 862,
        message: {
          message_id: 3,
          chat: { id: 860, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "run task",
        },
      }, chatKey, deps);

      expect(sourceRun).toHaveBeenCalledTimes(1);
      expect(targetRun).not.toHaveBeenCalled();
      expect(fallbackRequests.has(chatKey)).toBe(false);
      expect(notices).toEqual([]);
      expect(telegram.sendMessage.mock.calls.some(([body]: [any]) =>
        String(body?.text ?? "").includes("ordinary task failure"))).toBe(true);
    } finally {
      db.close();
    }
  });

});
