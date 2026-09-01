import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  dispatchClaimedInteractiveWithFallback,
  dispatchInteractiveTurnWithFallback,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import {
  buildScheduledInteractiveTurn,
  claimScheduledRoutineOccurrence,
  createScheduledRoutine,
  type ScheduledRoutine,
} from "../src/scheduledRoutines.js";
import {
  linkScheduledOccurrenceRun,
  parseScheduledOccurrenceEvidence,
  scheduledOccurrenceKey,
} from "../src/scheduledRunCorrelation.js";

const paths: string[] = [];

function mockClient() {
  return {
    capabilities: {
      maxMessageLength: 4096,
      editMessages: true,
      deleteMessages: true,
      previewStreaming: true,
      threads: true,
      attachments: true,
      typing: true,
      polling: true,
      remoteFileDownload: true,
      richMessages: true,
      formatting: "telegram-html",
    },
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    deleteMessage: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function routineFixture(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "one-shot-correlation",
    name: "Correlation qualification",
    instruction: "Return ROUTINE_TEST_OK.",
    kind: "companion",
    surfaceIdentity: "telegram:interactive",
    chatKey: "100",
    ownerKey: "owner:test",
    timezone: "UTC",
    schedule: { type: "once", localDateTime: "2026-09-01T20:00" },
    enabled: true,
    createdAt: "2026-09-01T19:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch {}
});

describe("authoritative scheduled Run correlation", () => {
  it("carries one claimed occurrence through BridgeEngine to its exact terminal Run", async () => {
    const path = join(tmpdir(), `scheduled-run-correlation-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-correlation-test", runId: "process-test" });
    try {
      const routine = routineFixture();
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:00:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);

      const runCli = vi.fn().mockResolvedValue(JSON.stringify({
        type: "result",
        result: "ROUTINE_TEST_OK",
        session_id: "scheduled-session",
      }));
      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      }, db, mockClient(), { runCli });

      const turn = buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey);
      await engine.handleInteractiveTurn(turn);

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.version).toBe(1);
      expect(evidence?.runId).toBeTruthy();
      const run = db.getRun(evidence!.runId!);
      expect(run).toEqual(expect.objectContaining({
        run_id: evidence!.runId,
        chat_id: routine.chatKey,
        bot: "claude",
        status: "done",
      }));
    } finally {
      db.close();
    }
  });

  it("rebinds a capacity-failed linked Run so provider fallback can complete the occurrence", { timeout: 20_000 }, async () => {
    const path = join(tmpdir(), `scheduled-run-fallback-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-fallback-test", runId: "process-test" });
    try {
      const routine = routineFixture({ id: "fallback-correlation", chatKey: "100" });
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:05:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);
      const exhaustedChats = new Set<string>();
      const claudeCli = vi.fn().mockRejectedValue(new Error("MODEL_CAPACITY_EXHAUSTED"));
      const codexCli = vi.fn().mockResolvedValue([
        JSON.stringify({ type: "thread.started", thread_id: "fallback-session" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ROUTINE_TEST_OK" } }),
      ].join("\n"));
      const claude = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "claude",
        botConfig: { command: "claude", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        hooks: { onCapacityExhausted: async (chatKey) => { exhaustedChats.add(chatKey); } },
      }, db, mockClient(), { runCli: claudeCli });
      const codex = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "codex",
        botConfig: { command: "codex", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
      }, db, mockClient(), { runCli: codexCli });
      const deps = {
        engines: { claude, codex },
        fallbackChain: new ProviderFallbackChain(["claude", "codex"], db),
        exhaustedChats,
        db,
        notify: async () => undefined,
      };
      for (const engine of Object.values(deps.engines)) {
        engine.setQueuedMessageHandler(async (queued) =>
          dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      setUserCliPreference(db, routine.chatKey, "claude");
      const turn = buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey);
      const outcome = await dispatchInteractiveTurnWithFallback(turn, deps);
      // Capacity fallback recovers the persisted occurrence through the pending queue.
      expect(["queued", "committed"]).toContain(outcome);
      expect(claudeCli).toHaveBeenCalled();
      expect(codexCli).toHaveBeenCalled();
      expect(db.pendingMsgCount("telegram:interactive", routine.chatKey)).toBe(0);

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.runId).toBeTruthy();
      const run = db.getRun(evidence!.runId!);
      expect(run).toEqual(expect.objectContaining({
        run_id: evidence!.runId,
        chat_id: routine.chatKey,
        bot: "codex",
        status: "done",
      }));
    } finally {
      db.close();
    }
  });

  it("allows rebinding only when the previously linked Run is missing, failed, or cancelled", () => {
    const path = join(tmpdir(), `scheduled-run-rebind-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-rebind-test", runId: "process-test" });
    try {
      const key = scheduledOccurrenceKey("routine-rebind", "2026-09-01T21:00:00.000Z");
      db.raw.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(
        key,
        JSON.stringify({ version: 1, claimedAt: "2026-09-01T21:00:00.000Z", runId: null }),
      );
      expect(linkScheduledOccurrenceRun(db, key, "run-a")).toBe(true);
      // No bridge_runs row yet: treat as replaceable so fallback can continue.
      expect(linkScheduledOccurrenceRun(db, key, "run-b")).toBe(true);
      expect(parseScheduledOccurrenceEvidence(db.getSetting(key))?.runId).toBe("run-b");

      db.insertRun("run-b", "100", "claude");
      expect(linkScheduledOccurrenceRun(db, key, "run-c")).toBe(false);

      db.updateRunFailed("run-b", "MODEL_CAPACITY_EXHAUSTED");
      expect(linkScheduledOccurrenceRun(db, key, "run-c")).toBe(true);
      expect(parseScheduledOccurrenceEvidence(db.getSetting(key))?.runId).toBe("run-c");

      db.insertRun("run-c", "100", "codex");
      db.updateRunCompleted("run-c", "ok", null);
      expect(linkScheduledOccurrenceRun(db, key, "run-d")).toBe(false);
    } finally {
      db.close();
    }
  });
});
