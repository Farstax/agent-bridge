import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";
import { dispatchClaimedInteractiveWithFallback } from "../src/interactiveBot.js";
import { WorkerFallbackChain } from "../src/workerFallback.js";

function client() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeBackground(text: string, sessionId: string): string {
  return [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "bg", name: "Bash", input: { run_in_background: true } }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId }),
  ].join("\n");
}

describe("continuation fallback admitted-turn envelope", () => {
  it("does not enqueue a duplicate when fallback continues an already-claimed row", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const exhaustedChats = new Set<string>();
    const chain = new WorkerFallbackChain(["claude", "codex"], db);
    let processState: "live" | "absent" = "live";
    const claudeRun = vi.fn()
      .mockResolvedValueOnce({ text: claudeBackground("background started", "claude-session") })
      .mockRejectedValueOnce(new Error("rate limit"));
    const codexRun = vi.fn().mockResolvedValue({ text: [
      JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "completed once" } }),
    ].join("\n") });
    const makeEngine = (kind: "claude" | "codex", runCliAsync: any) => new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind,
      botConfig: { command: kind, modelPreference: [] }, allowedUserIds: new Set(["42"]),
      executionMode: "safe", busyMessageMode: "augment", asyncEnabled: true, pollIntervalMs: 1,
      hooks: { onCapacityExhausted: async (chatKey: string) => { exhaustedChats.add(chatKey); } },
    }, db, telegram, { runCliAsync }, {
      hasLiveRunOwnedDescendants: () => processState === "live",
      getRunOwnedProcessState: () => processState === "live" ? "live" : "absent",
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }),
      sleep: vi.fn(async () => { processState = "absent"; }),
    });
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const deps = { engines, fallbackChain: chain, exhaustedChats, db, notify: vi.fn() };
    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (message) => dispatchClaimedInteractiveWithFallback(message, message.chatKey, deps));
    }

    try {
      db.enqueueMsg("telegram:interactive", "100", { prompt: "finish this", chatId: 100, chatType: "private", userId: 42 });
      const handle = db.acquireLock("telegram:interactive", "100");
      expect(handle).not.toBeNull();
      const claimed = db.claimNextPendingMsg(handle!);
      expect(claimed).not.toBeNull();
      await dispatchClaimedInteractiveWithFallback({ ...claimed!, laneHandle: handle! }, "100", deps);
      expect(db.completePendingMsg(handle!, claimed!.id)).toBe(true);

      expect(codexRun).toHaveBeenCalledOnce();
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(telegram.sendMessage.mock.calls.map(([body]: [any]) => body.text)).toEqual(["completed once"]);
    } finally {
      db.close();
    }
  });

  it("re-admits the original attachment when a fresh provider takes over", async () => {
    const db = openDb(":memory:");
    const repo = new ContinuationRepository(db.raw);
    db.insertRun("attachment-run", "100", "claude");
    repo.saveWaiting({
      runId: "attachment-run", surface: "telegram:interactive", chatKey: "100", chatId: 100, threadId: null,
      bot: "claude", sessionId: "claude-session", prompt: "inspect the image", chatType: "private", userId: 42,
      attachments: ["/tmp/bridge-uploads/keep-me.png"], executionMode: "async",
      triggerKind: "run-owned-background-process", triggerId: "attachment-run", resumptionCount: 0,
      pendingIds: [], startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } as any);
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() }, {
      hasLiveRunOwnedDescendants: () => false, getRunOwnedProcessState: () => "absent",
      killRunOwnedDescendants: vi.fn(async () => {}), sleep: vi.fn(async () => {}),
    });

    try {
      await expect(engine.handoffActiveContinuationForFallback("100")).resolves.toBe("queued");
      expect(db.dequeueMsgs("telegram:interactive", "100")[0].attachments).toEqual(["/tmp/bridge-uploads/keep-me.png"]);
    } finally {
      db.close();
    }
  });

  it("keeps the original prompt and chat envelope through multiple continuation checkpoints", () => {
    const db = openDb(":memory:");
    const repo = new ContinuationRepository(db.raw);
    const base = {
      runId: "multi-stage", surface: "telegram:interactive", chatKey: "100:7", chatId: 100, threadId: 7,
      bot: "claude", sessionId: "claude-session", prompt: "original user request", chatType: "supergroup", userId: 42,
      attachments: ["/tmp/keep.png"], executionMode: "async" as const,
      triggerKind: "run-owned-background-process" as const, triggerId: "multi-stage", resumptionCount: 0,
      pendingIds: [], startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    repo.saveWaiting(base as any);
    repo.saveWaiting({ ...base, prompt: "The background work finished. Continue.", chatType: undefined, resumptionCount: 1, sessionId: "claude-session-2" } as any);
    const record = repo.get("multi-stage");
    expect(record?.prompt).toBe("original user request");
    expect(record?.chatType).toBe("supergroup");
    expect((record as any)?.attachments).toEqual(["/tmp/keep.png"]);
    db.close();
  });

  it("fails closed when continuation attachment persistence cannot copy the source", () => {
    const db = openDb(":memory:");
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    try {
      expect(() => (engine as any)._persistContinuationAttachments("copy-failure", ["/tmp/disposable-upload-that-is-gone.png"]))
        .toThrow("continuation attachment could not be persisted");
    } finally {
      db.close();
    }
  });
});
