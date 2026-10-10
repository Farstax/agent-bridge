import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine, type ProviderFallbackReason } from "../src/engine.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchClaimedInteractiveWithFallback, dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import { attachProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { createSurfaceNeutralProviderRouter } from "../src/surfaceNeutralProviderRouter.js";
import { TELEGRAM_SURFACE_CAPABILITIES } from "../src/platform.js";
import { ProviderStallError } from "../src/cli.js";

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

const submitted = (message: string, promptSubmitted: boolean) =>
  attachProviderFailureEvidence(new Error(message), { promptSubmitted });

async function runCodexThenClaude(sourceRun: ReturnType<typeof vi.fn>, sourceKind: "codex" | "claude" = "codex", locked = false) {
  const targetKind = sourceKind === "codex" ? "claude" : "codex";
  const db = openDb(":memory:");
  const chatKey = "946";
  const fallbackRequests = new Map<string, ProviderFallbackReason>();
  const fallbackChain = new ProviderFallbackChain(locked ? [sourceKind] : [sourceKind, targetKind], db, "telegram:interactive", () => true);
  const telegram = client();
  const targetRun = vi.fn(async () => ({ text: "answer from fallback", sessionId: "claude-fresh", stopReason: "end_turn" }));
  const make = (kind: "codex" | "claude", runProviderInvocation: any) => new BridgeEngine({
    surfaceIdentity: "telegram:interactive",
    kind,
    botConfig: { command: kind, modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    busyMessageMode: "augment",
    pollIntervalMs: 1000,
    workingDir: process.cwd(),
    hooks: {
      onProviderFallbackRequested: async (key, reason) => { fallbackRequests.set(key, reason); },
    },
  }, db, telegram, { runProviderInvocation } as any);
  const engines = { [sourceKind]: make(sourceKind, sourceRun), [targetKind]: make(targetKind, targetRun) } as Record<"codex" | "claude", BridgeEngine>;
  const notices: string[] = [];
  const deps = { engines, fallbackChain, fallbackRequests, db, notify: async (m: string) => { notices.push(m); } };
  for (const engine of Object.values(engines)) {
    engine.setQueuedMessageHandler(async (queued) => dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
  }
  setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey }, sourceKind);
  await dispatchInteractiveWithFallback({
    update_id: 946,
    message: { message_id: 1, chat: { id: 946, type: "private" }, from: { id: 42, first_name: "T" }, text: "do the task" },
  }, chatKey, deps);
  const texts = telegram.sendMessage.mock.calls.map(([body]: [any]) => String(body?.text ?? ""));
  return { db, targetRun, texts, notices };
}

describe("evidence-based provider recovery through the interactive route owner", () => {
  it("falls back once when an unclassified failure is proven to precede prompt submission", async () => {
    const sourceRun = vi.fn(async () => { throw submitted("Internal error: could not initialise", false); });
    const { db, targetRun, texts } = await runCodexThenClaude(sourceRun);
    try {
      expect(sourceRun).toHaveBeenCalledTimes(1);
      expect(targetRun).toHaveBeenCalledTimes(1);
      expect(texts.filter((t: string) => t === "answer from fallback")).toHaveLength(1);
    } finally { db.close(); }
  });

  it("never replays after prompt submission when the failure is unclassified", async () => {
    const sourceRun = vi.fn(async () => { throw submitted("Internal error: connection lost mid-task", true); });
    const { db, targetRun, texts } = await runCodexThenClaude(sourceRun);
    try {
      expect(sourceRun).toHaveBeenCalledTimes(1);
      expect(targetRun).not.toHaveBeenCalled();
      expect(texts.some((t: string) => t.includes("connection lost mid-task"))).toBe(true);
    } finally { db.close(); }
  });

  it("keeps an untagged unknown error (ordinary task/repository failure) on the in-place error path", async () => {
    const sourceRun = vi.fn(async () => { throw new Error("Internal error: something in the repo"); });
    const { db, targetRun } = await runCodexThenClaude(sourceRun);
    try {
      expect(targetRun).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("does not let a later pre-prompt failure erase an earlier submission across the fresh-session retry", async () => {
    let calls = 0;
    const sourceRun = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw submitted("socket hang up", true);
      throw submitted("Internal error: could not initialise", false);
    });
    const { db, targetRun } = await runCodexThenClaude(sourceRun);
    try {
      expect(sourceRun).toHaveBeenCalledTimes(2);
      expect(targetRun).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("treats a later local error after a pre-prompt transient first attempt as possibly submitted", async () => {
    let calls = 0;
    const sourceRun = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw submitted("ECONNREFUSED at spawn", false);
      // The silent retry ran the task, then a local post-provider step failed.
      throw new Error("Internal error: upload hook exploded");
    });
    const { db, targetRun } = await runCodexThenClaude(sourceRun);
    try {
      expect(sourceRun).toHaveBeenCalledTimes(2);
      expect(targetRun).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("treats a first attempt without evidence as possibly submitted (fail closed)", async () => {
    let calls = 0;
    const sourceRun = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      throw submitted("Internal error: could not initialise", false);
    });
    const { db, targetRun } = await runCodexThenClaude(sourceRun);
    try {
      expect(targetRun).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe("Claude weekly limit incident", () => {
  it("routes a configured claude -> codex chain to one final answer without a generic same-session retry", async () => {
    const claudeRun = vi.fn(async () => { throw new Error("You've hit your weekly limit · resets 11am (Europe/London)"); });
    const { db, targetRun, texts } = await runCodexThenClaude(claudeRun, "claude");
    try {
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(targetRun).toHaveBeenCalledTimes(1);
      expect(texts.filter((t: string) => t === "answer from fallback")).toHaveLength(1);
      expect(texts.some((t: string) => t.includes("weekly limit"))).toBe(false);
    } finally { db.close(); }
  });
});

describe("provider-locked surface", () => {
  it("never acquires another provider even when the weekly limit is recognised as capacity", async () => {
    const claudeRun = vi.fn(async () => { throw new Error("You've hit your weekly limit · resets 11am (Europe/London)"); });
    const { db, targetRun } = await runCodexThenClaude(claudeRun, "claude", true);
    try {
      expect(claudeRun).toHaveBeenCalledTimes(1);
      expect(targetRun).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe("the surface-neutral route owner consumes the same verdict", () => {
  function routerOver(codexError: Error) {
    const db = openDb(":memory:");
    const codex = vi.fn(async () => { throw codexError; });
    const claude = vi.fn(async () => ({ text: "claude answer", sessionId: "s", stopReason: "end_turn" }));
    const router = createSurfaceNeutralProviderRouter({
      db,
      surfaceIdentity: "acp:test",
      initialProvider: "codex",
      providerChain: ["codex", "claude"],
      engineForProvider: (provider) => ({
        executeSurfaceNeutralTurn: provider === "codex" ? codex : claude,
      }) as any,
    });
    const input = {
      prompt: "p", sessionId: null, chatId: "c", chatKey: "k", laneHandle: {} as any, runId: "r",
      eventContext: { runId: "r", bot: "codex", chatId: "c", chatKey: "k" } as any,
      collect: vi.fn(),
    };
    return { db, codex, claude, router, input };
  }

  it("advances on a proven pre-prompt unclassified failure", async () => {
    const { db, claude, router, input } = routerOver(submitted("Internal error: init", false));
    try {
      await router.executeSurfaceNeutralTurn(input as any);
      expect(claude).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("advances on provider rejections but not on post-submission transport failures", async () => {
    const advancing = [new Error("usage limit reached"), new Error("Failed to authenticate"), submitted("socket hang up", false)];
    for (const error of advancing) {
      const { db, claude, router, input } = routerOver(error);
      try {
        await router.executeSurfaceNeutralTurn(input as any);
        expect(claude).toHaveBeenCalledTimes(1);
      } finally { db.close(); }
    }
    for (const error of [submitted("socket hang up", true), new Error("socket hang up"), new ProviderStallError("stalled")]) {
      const { db, claude, router, input } = routerOver(error);
      try {
        await expect(router.executeSurfaceNeutralTurn(input as any)).rejects.toThrow();
        expect(claude).not.toHaveBeenCalled();
      } finally { db.close(); }
    }
  });

  it("does not advance on an unclassified failure after submission or without evidence", async () => {
    for (const error of [submitted("Internal error: lost", true), new Error("Internal error: lost")]) {
      const { db, claude, router, input } = routerOver(error);
      try {
        await expect(router.executeSurfaceNeutralTurn(input as any)).rejects.toThrow();
        expect(claude).not.toHaveBeenCalled();
      } finally { db.close(); }
    }
  });
});

describe("stopped lane", () => {
  it("never advances the chain when /stop lands while a pre-prompt provider failure is being reported", async () => {
    const db = openDb(":memory:");
    try {
      const engine: BridgeEngine = new BridgeEngine({
        surfaceIdentity: "acp:test",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
      }, db, client(), {
        runProviderInvocation: async () => {
          (engine as any).laneCoordinator.markAborted((engine as any)._executionLane("k"));
          throw attachProviderFailureEvidence(new Error("Internal error: spawn killed"), { promptSubmitted: false });
        },
      } as any);
      const claude = vi.fn(async () => ({ text: "must not run", sessionId: "s", stopReason: "end_turn" }));
      const router = createSurfaceNeutralProviderRouter({
        db,
        surfaceIdentity: "acp:test",
        initialProvider: "codex",
        providerChain: ["codex", "claude"],
        engineForProvider: (provider) => (provider === "codex" ? engine : { executeSurfaceNeutralTurn: claude }) as any,
      });
      const laneHandle = db.acquireLock("acp:test", "k");
      expect(laneHandle).not.toBeNull();
      await expect(router.executeSurfaceNeutralTurn({
        prompt: "p", sessionId: null, chatId: "c", chatKey: "k", laneHandle: laneHandle as any, runId: "r-stop",
        eventContext: { runId: "r-stop", bot: "codex", chatId: "c", chatKey: "k" } as any,
        collect: () => {},
      })).rejects.toThrow();
      expect(claude).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
