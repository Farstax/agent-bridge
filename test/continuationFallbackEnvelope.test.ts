import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";
import { dispatchClaimedInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
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
  it("rolls back every claimed attachment replacement when a later row no longer matches", () => {
    const db = openDb(":memory:");
    const originalA = "/tmp/original-a.png";
    const originalB = "/tmp/original-b.png";
    const continuationOwned = "/tmp/bridge-continuation-attachments-multi-row/0-owned.png";
    db.enqueueMsg("telegram:interactive", "100", { prompt: "first", chatId: 100, chatType: "private", attachments: [originalA] });
    db.enqueueMsg("telegram:interactive", "100", { prompt: "second", chatId: 100, chatType: "private", attachments: [originalB] });
    const handle = db.acquireLock("telegram:interactive", "100");
    const claimed = db.claimPendingMsgs(handle!);
    expect(claimed).toHaveLength(2);

    try {
      db.raw.prepare("UPDATE pending_messages SET claim_acquisition_id = ? WHERE id = ?")
        .run("different-acquisition", claimed[1].id);

      expect(db.replaceClaimedPendingAttachments(handle!, claimed.map((row) => row.id), [continuationOwned])).toBe(false);
      expect(db.dequeueMsgs("telegram:interactive", "100").map((row) => row.attachments)).toEqual([[originalA], [originalB]]);
      expect(db.dequeueMsgs("telegram:interactive", "100").flatMap((row) => row.attachments)).not.toContain(continuationOwned);
    } finally {
      db.close();
    }
  });

  it("preserves checkpoint staging through delivery failure and queue recovery", async () => {
    const db = openDb(":memory:");
    const sourceDir = mkdtempSync(join(tmpdir(), "delivery-failure-source-"));
    const source = join(sourceDir, "attachment.png");
    writeFileSync(source, "recoverable attachment");
    const runId = "delivery-failure-recovery";
    db.insertRun(runId, "100", "claude");
    db.enqueueMsg("telegram:interactive", "100", { prompt: "recover this", chatId: 100, chatType: "private", attachments: [source] });
    const handle = db.acquireLock("telegram:interactive", "100");
    const row = db.claimNextPendingMsg(handle!);
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() }, {
      getRunOwnedProcessState: () => "absent", killRunOwnedDescendants: vi.fn(async () => {}), sleep: vi.fn(async () => {}),
    });
    let recoveredAttachment: string | undefined;
    engine.setQueuedMessageHandler(async (message) => {
      recoveredAttachment = message.attachments[0];
      expect(readFileSync(recoveredAttachment, "utf8")).toBe("recoverable attachment");
      return "committed";
    });
    try {
      expect((engine as any)._checkpointContinuationBeforeDelivery({
        mode: "async", prompt: "recover this", isInitialResult: true, chatId: 100, chatKey: "100", chatType: "private",
        userId: 42, threadId: undefined, attachments: [source], laneHandle: handle, pendingIds: [row!.id], runId,
        continuationStartedAtMs: null, resumptionCount: 0,
      }, { text: "background", sessionId: "claude-session", memoryCandidates: [], continuationHint: "background-process", continuationProcessObserved: true } as any)).toBe(true);
      const staged = (db.dequeueMsgs("telegram:interactive", "100")[0]).attachments[0];

      await (engine as any)._cancelUndeliveredContinuation(runId, "delivery failed");
      expect(readFileSync(staged, "utf8")).toBe("recoverable attachment");
      db.releasePendingClaim(handle!, row!.id);
      db.unlock(handle!);
      await engine.recoverPendingQueue("100");

      expect(recoveredAttachment).toBe(staged);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(() => readFileSync(staged)).toThrow();
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(join(tmpdir(), `bridge-continuation-attachments-${runId}`), { recursive: true, force: true });
      db.close();
    }
  });

  it("contains live descendants when synchronous checkpointing fails", async () => {
    const db = openDb(":memory:");
    const kill = vi.fn(async () => {});
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() }, {
      hasLiveRunOwnedDescendants: () => true, getRunOwnedProcessState: () => "live", killRunOwnedDescendants: kill,
      sleep: vi.fn(async () => {}),
    });
    const handle = db.acquireLock("telegram:interactive", "100");
    vi.spyOn(engine, "executePrompt").mockResolvedValue({
      text: "background", sessionId: "claude-session", memoryCandidates: [],
      continuationHint: "background-process", continuationProcessObserved: true,
    } as any);
    vi.spyOn((engine as any), "_checkpointContinuationBeforeDelivery").mockImplementation(() => {
      throw new Error("attachment checkpoint failed");
    });
    try {
      await expect((engine as any)._executeAndDeliverTurnAttempt({
        mode: "sync", prompt: "inspect", sessionId: "claude-session", isInitialResult: true,
        chatId: 100, chatKey: "100", chatType: "private", userId: 42, threadId: undefined, attachments: [],
        laneHandle: handle, pendingIds: [], runId: "sync-checkpoint-failure", eventContext: {}, collect: vi.fn(),
        continuationStartedAtMs: null, resumptionCount: 0,
      })).rejects.toThrow("attachment checkpoint failed");
      expect(kill).toHaveBeenCalledWith("sync-checkpoint-failure");
    } finally {
      db.close();
    }
  });

  it("cleans staged continuation attachments when row ownership replacement fails", () => {
    const db = openDb(":memory:");
    db.enqueueMsg("telegram:interactive", "100", { prompt: "inspect", chatId: 100, chatType: "private", userId: 42 });
    const handle = db.acquireLock("telegram:interactive", "100");
    const row = db.claimNextPendingMsg(handle!);
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    const staged = "/tmp/bridge-continuation-attachments-failed-checkpoint/0-file.png";
    vi.spyOn((engine as any), "_persistContinuationAttachments").mockReturnValue([staged]);
    vi.spyOn(db, "replaceClaimedPendingAttachments").mockReturnValue(false);
    const cleanup = vi.spyOn((engine as any), "_cleanupContinuationAttachments");
    try {
      expect(() => (engine as any)._checkpointContinuationBeforeDelivery({
        mode: "async", prompt: "inspect", isInitialResult: true, chatId: 100, chatKey: "100", chatType: "private", userId: 42,
        threadId: undefined, attachments: ["/tmp/source.png"], laneHandle: handle, pendingIds: [row!.id], runId: "failed-checkpoint",
        continuationStartedAtMs: null, resumptionCount: 0,
      }, { text: "background", sessionId: "claude-session", memoryCandidates: [], continuationHint: "background-process", continuationProcessObserved: true } as any))
        .toThrow();
      expect(cleanup).toHaveBeenCalledWith([staged]);
    } finally {
      db.close();
    }
  });

  it("keeps a claimed row on the continuation-owned path when checkpoint save loses a race", () => {
    const db = openDb(":memory:");
    const source = "/tmp/checkpoint-race-source.png";
    const owned = "/tmp/bridge-continuation-attachments-checkpoint-race/0-checkpoint-race-source.png";
    writeFileSync(source, "attachment");
    db.enqueueMsg("telegram:interactive", "100", { prompt: "inspect", chatId: 100, chatType: "private", userId: 42, attachments: [source] });
    const handle = db.acquireLock("telegram:interactive", "100");
    const row = db.claimNextPendingMsg(handle!);
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    vi.spyOn((engine as any).continuationStore, "saveWaiting").mockReturnValue(null);
    try {
      expect(() => (engine as any)._checkpointContinuationBeforeDelivery({
        mode: "async", prompt: "inspect", isInitialResult: true, chatId: 100, chatKey: "100", chatType: "private", userId: 42,
        threadId: undefined, attachments: [source], laneHandle: handle, pendingIds: [row!.id], runId: "checkpoint-race",
        continuationStartedAtMs: null, resumptionCount: 0,
      }, { text: "background", sessionId: "claude-session", memoryCandidates: [], continuationHint: "background-process", continuationProcessObserved: true } as any)).toThrow();
      const persisted = db.raw.prepare("SELECT attachments_json AS attachmentsJson FROM pending_messages WHERE id = ?").get(row!.id) as { attachmentsJson: string };
      expect(JSON.parse(persisted.attachmentsJson)).toEqual([owned]);
      expect(readFileSync(owned, "utf8")).toBe("attachment");
    } finally {
      rmSync(source, { force: true });
      rmSync(join(tmpdir(), "bridge-continuation-attachments-checkpoint-race"), { recursive: true, force: true });
      db.close();
    }
  });

  it("removes only files created by a partial copy into existing continuation staging", () => {
    const db = openDb(":memory:");
    const staging = join(tmpdir(), "bridge-continuation-attachments-partial-copy");
    const sourceDir = mkdtempSync(join(tmpdir(), "continuation-partial-source-"));
    const source = join(sourceDir, "first.png");
    const existing = join(staging, "existing.png");
    writeFileSync(source, "first");
    mkdirSync(staging, { recursive: true });
    writeFileSync(existing, "keep");
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    try {
      expect(() => (engine as any)._persistContinuationAttachments("partial-copy", [source, "/tmp/missing-partial-copy.png"]))
        .toThrow("continuation attachment could not be persisted");
      expect(() => readFileSync(join(staging, "0-first.png"))).toThrow();
      expect(readFileSync(existing, "utf8")).toBe("keep");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
      db.close();
    }
  });

  it("contains live descendants when attachment checkpointing fails before waiting is saved", async () => {
    const db = openDb(":memory:");
    const kill = vi.fn(async () => {});
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() }, {
      hasLiveRunOwnedDescendants: () => true,
      getRunOwnedProcessState: () => "live",
      killRunOwnedDescendants: kill,
      sleep: vi.fn(async () => {}),
    });
    try {
      await expect((engine as any)._cancelUndeliveredContinuation("unsaved-attachment-run", "attachment checkpoint failed"))
        .resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith("unsaved-attachment-run");
    } finally {
      db.close();
    }
  });

  it("replaces an existing pending row's disposable attachment with the continuation-owned copy", async () => {
    const db = openDb(":memory:");
    const source = "/tmp/disposable-upload.png";
    const owned = "/tmp/bridge-continuation-attachments-existing-row-run/0-disposable-upload.png";
    writeFileSync(source, "attachment");
    db.enqueueMsg("telegram:interactive", "100", { prompt: "inspect", chatId: 100, chatType: "private", userId: 42, attachments: [source] });
    const handle = db.acquireLock("telegram:interactive", "100");
    const row = db.claimNextPendingMsg(handle!);
    db.insertRun("existing-row-run", "100", "claude");
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() }, {
      hasLiveRunOwnedDescendants: () => false, getRunOwnedProcessState: () => "absent",
      killRunOwnedDescendants: vi.fn(async () => {}), sleep: vi.fn(async () => {}),
    });
    try {
      expect((engine as any)._checkpointContinuationBeforeDelivery({
        mode: "async", prompt: "inspect", isInitialResult: true, chatId: 100, chatKey: "100", chatType: "private", userId: 42,
        threadId: undefined, attachments: [source], laneHandle: handle, pendingIds: [row!.id], runId: "existing-row-run",
        continuationStartedAtMs: null, resumptionCount: 0,
      }, { text: "background", sessionId: "claude-session", memoryCandidates: [], continuationHint: "background-process", continuationProcessObserved: true } as any)).toBe(true);
      await expect(engine.handoffActiveContinuationForFallback("100")).resolves.toBe("queued");
      const persisted = db.raw.prepare("SELECT attachments_json AS attachmentsJson FROM pending_messages WHERE id = ?").get(row!.id) as { attachmentsJson: string };
      expect(JSON.parse(persisted.attachmentsJson)).toEqual([owned]);
    } finally {
      rmSync(source, { force: true });
      db.close();
    }
  });

  it("cleans continuation-owned attachment staging on terminal completion", async () => {
    const db = openDb(":memory:");
    const staging = mkdtempSync(join(tmpdir(), "bridge-continuation-attachments-terminal-"));
    const attachment = join(staging, "file.png");
    writeFileSync(attachment, "attachment");
    const repo = new ContinuationRepository(db.raw);
    db.insertRun("terminal-attachment-run", "100", "claude");
    repo.saveWaiting({
      runId: "terminal-attachment-run", surface: "telegram:interactive", chatKey: "100", chatId: 100, threadId: null,
      bot: "claude", sessionId: "claude-session", prompt: "finish", chatType: "private", userId: 42,
      attachments: [attachment], executionMode: "async", triggerKind: "run-owned-background-process", triggerId: "terminal-attachment-run",
      resumptionCount: 0, pendingIds: [], startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    } as any);
    const handle = db.acquireLock("telegram:interactive", "100");
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    try {
      await expect((engine as any)._continueFromDeliveredResult({
        mode: "async", result: { text: "finished", sessionId: "claude-session" }, chatId: 100, chatKey: "100", chatType: "private",
        userId: 42, attachments: [attachment], threadId: undefined, laneHandle: handle, pendingIds: [], runId: "terminal-attachment-run",
        eventContext: {}, collect: vi.fn(), finalize: vi.fn(), continuationStartedAtMs: null, resumptionCount: 0,
      })).resolves.toBe(true);
      expect(() => readFileSync(attachment)).toThrow();
    } finally {
      rmSync(staging, { recursive: true, force: true });
      db.close();
    }
  });

  it("does not enqueue a duplicate when fallback continues an already-claimed row", async () => {
    const db = openDb(":memory:");
    const telegram = client();
    const exhaustedChats = new Set<string>();
    const chain = new WorkerFallbackChain(["claude", "codex"], db);
    let processState: "live" | "absent" = "live";
    const claudeRun = vi.fn()
      .mockResolvedValueOnce({ text: [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-bg", name: "Bash", input: { run_in_background: true } }] } }),
        JSON.stringify({ type: "result", subtype: "success", result: "background started", session_id: "claude-session" }),
      ].join("\n") })
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

  it("uses the authoritative continuation attachment during immediate claimed-row fallback", async () => {
    const db = openDb(":memory:");
    const sourceDir = mkdtempSync(join(tmpdir(), "fallback-source-"));
    const source = join(sourceDir, "fallback.png");
    writeFileSync(source, "fallback attachment");
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
      getRunOwnedProcessState: () => processState === "live" ? "live" : "absent",
      killRunOwnedDescendants: vi.fn(async () => { processState = "absent"; }), sleep: vi.fn(async () => { processState = "absent"; }),
    });
    const engines = { claude: makeEngine("claude", claudeRun), codex: makeEngine("codex", codexRun) };
    const persist = vi.spyOn(engines.claude as any, "_persistContinuationAttachments");
    const codexPrompt = vi.spyOn(engines.codex, "executePromptAsync");
    const deps = { engines, fallbackChain: chain, exhaustedChats, db, notify: vi.fn() };
    for (const engine of Object.values(engines)) {
      engine.setQueuedMessageHandler(async (message) => dispatchClaimedInteractiveWithFallback(message, message.chatKey, deps));
    }
    try {
      setUserCliPreference(db, "100", "claude");
      db.enqueueMsg("telegram:interactive", "100", { prompt: "finish this", chatId: 100, chatType: "private", userId: 42, attachments: [source] });
      const handle = db.acquireLock("telegram:interactive", "100");
      const claimed = db.claimNextPendingMsg(handle!);
      const runId = "immediate-fallback-run";
      db.insertRun(runId, "100", "claude");
      expect((engines.claude as any)._checkpointContinuationBeforeDelivery({
        mode: "async", prompt: "finish this", isInitialResult: true, chatId: 100, chatKey: "100", chatType: "private",
        userId: 42, threadId: undefined, attachments: [source], laneHandle: handle, pendingIds: [claimed!.id], runId,
        continuationStartedAtMs: null, resumptionCount: 0,
      }, { text: "background started", sessionId: "claude-session", memoryCandidates: [], continuationHint: "background-process", continuationProcessObserved: true } as any)).toBe(true);
      engines.claude.executeClaimedMessage = vi.fn(async () => {
        exhaustedChats.add("100");
        return "failed";
      });
      await dispatchClaimedInteractiveWithFallback({ ...claimed!, laneHandle: handle! }, "100", deps);
      const staged = (persist.mock.results[0] as any).value[0] as string;

      expect(codexRun).toHaveBeenCalledOnce();
      expect(codexPrompt.mock.calls[0][5]).toEqual([staged]);
      expect(db.completePendingMsg(handle!, claimed!.id)).toBe(true);
      (engines.codex as any)._deleteQueuedAttachments([staged]);
      expect(db.pendingMsgCount("telegram:interactive", "100")).toBe(0);
      expect(() => readFileSync(staged)).toThrow();
      expect(() => readFileSync(source)).toThrow();
      expect(telegram.sendMessage.mock.calls.map(([body]: [any]) => body.text)).toEqual(["completed once"]);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
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

  it("reuses continuation-owned attachments across repeated checkpoints", () => {
    const db = openDb(":memory:");
    const sourceDir = mkdtempSync(join(tmpdir(), "continuation-source-"));
    const source = join(sourceDir, "image.png");
    writeFileSync(source, "image");
    const engine = new BridgeEngine({
      surfaceIdentity: "telegram:interactive", kind: "claude", botConfig: { command: "claude", modelPreference: [] },
      allowedUserIds: new Set(["42"]), executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1,
    }, db, client(), { runCliAsync: vi.fn() });
    try {
      const first = (engine as any)._persistContinuationAttachments("repeat", [source]);
      const second = (engine as any)._persistContinuationAttachments("repeat", first);
      expect(second).toEqual(first);
      expect(readFileSync(second[0], "utf8")).toBe("image");
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(join(tmpdir(), "bridge-continuation-attachments-repeat"), { recursive: true, force: true });
      db.close();
    }
  });
});
