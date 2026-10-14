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
import { acpEngineExec } from "./support/acpEngineExec.js";
import {
  buildScheduledInteractiveTurn,
  claimScheduledRoutineOccurrence,
  createScheduledRoutine,
  type ScheduledRoutine,
  scanScheduledRoutines,
  requestScheduledRoutineRun,
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
    delivery: { chatId: 100, chatType: "private" },
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

      const runCli = vi.fn().mockResolvedValue([JSON.stringify({ type: "text", data: "ROUTINE_TEST_OK" }), JSON.stringify({ type: "end", sessionId: "scheduled-session", stopReason: "end_turn" })].join("\n") + "\n");
      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, mockClient(), acpEngineExec(runCli));

      const turn = buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey);
      await engine.handleInteractiveTurn(turn);

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.version).toBe(1);
      expect(evidence?.runId).toBeTruthy();
      const run = db.getRun(evidence!.runId!);
      expect(run).toEqual(expect.objectContaining({
        run_id: evidence!.runId,
        chat_id: routine.chatKey,
        bot: "cursor",
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
      const codexCli = vi.fn().mockResolvedValue({ text: "ROUTINE_TEST_OK", sessionId: "11111111-2222-4333-8444-555555555555", stopReason: "end_turn" as const });
      const claude = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
        hooks: { onCapacityExhausted: async (chatKey) => { exhaustedChats.add(chatKey); } },
      }, db, mockClient(), acpEngineExec(claudeCli));
      const codex = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "antigravity",
        botConfig: { command: "agy", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, mockClient(), { runProviderInvocation: codexCli });
      const deps = {
        engines: { cursor: claude, antigravity: codex },
        fallbackChain: new ProviderFallbackChain(["cursor", "antigravity"], db, "telegram:interactive",
         () => true),
        exhaustedChats,
        db,
        notify: async () => undefined,
      };
      for (const engine of Object.values(deps.engines)) {
        engine.setQueuedMessageHandler(async (queued) =>
          dispatchClaimedInteractiveWithFallback(queued, queued.chatKey, deps));
      }

      setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: routine.chatKey }, "cursor");
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
        bot: "antigravity",
        status: "done",
      }));
    } finally {
      db.close();
    }
  });

  it("links a durable failed Run when provider errors are swallowed as null delivery", async () => {
    const path = join(tmpdir(), `scheduled-run-failed-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-failed-test", runId: "process-test" });
    try {
      const routine = routineFixture({ id: "failed-correlation" });
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:10:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);
      const runCli = vi.fn().mockImplementation(async (_command: string, _args: string[], _cwd: string, options: any) => {
        options?.onEvent?.({
          type: "run.started",
          version: 1,
          id: "evt-start",
          runId: options.eventContext.runId,
          timestamp: new Date().toISOString(),
          bot: "cursor",
          chatId: String(routine.chatKey),
          chatKey: routine.chatKey,
          command: "cursor",
          cwd: "/tmp",
          model: null,
        });
        options?.onEvent?.({
          type: "run.failed",
          version: 1,
          id: "evt-fail",
          runId: options.eventContext.runId,
          timestamp: new Date().toISOString(),
          bot: "cursor",
          chatId: String(routine.chatKey),
          chatKey: routine.chatKey,
          category: "provider",
          error: "provider blew up",
        });
        throw new Error("provider blew up");
      });
      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000, workingDir: process.cwd(),
      }, db, mockClient(), acpEngineExec(runCli));

      await engine.handleInteractiveTurn(buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey));

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.runId).toBeTruthy();
      const run = db.getRun(evidence!.runId!);
      expect(run).toEqual(expect.objectContaining({
        run_id: evidence!.runId,
        chat_id: routine.chatKey,
        bot: "cursor",
        status: "failed",
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

      db.insertRun("run-b", { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "cursor");
      expect(linkScheduledOccurrenceRun(db, key, "run-c")).toBe(false);

      db.updateRunFailed("run-b", "MODEL_CAPACITY_EXHAUSTED");
      expect(linkScheduledOccurrenceRun(db, key, "run-c")).toBe(true);
      expect(parseScheduledOccurrenceEvidence(db.getSetting(key))?.runId).toBe("run-c");

      db.insertRun("run-c", { surfaceIdentity: "telegram:interactive", chatKey: "100" }, "codex");
      db.updateRunCompleted("run-c", "ok", null);
      expect(linkScheduledOccurrenceRun(db, key, "run-d")).toBe(false);
    } finally {
      db.close();
    }
  });
  it("marks scheduled occurrence failed with pre_admission_failed when onBeforeExecute rejects before Run admission", async () => {
    const path = join(tmpdir(), `scheduled-run-preadmit-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-preadmit-test", runId: "process-test" });
    try {
      const routine = routineFixture({ id: "preadmit-fail" });
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:20:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);

      const runCli = vi.fn();
      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
        hooks: {
          onBeforeExecute: async (rawPrompt) => {
            throw new Error("Admission policy gate rejected");
          },
        },
      }, db, mockClient(), acpEngineExec(runCli));

      const turn = buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey);
      const outcome = await engine.handleInteractiveTurn(turn);
      expect(outcome).toBe("failed");
      expect(runCli).not.toHaveBeenCalled();

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.version).toBe(1);
      expect(evidence?.runId).toBeNull();
      expect(evidence?.status).toBe("failed");
      expect(evidence?.error).toBe("pre_admission_failed");

      // Verify runtime inspector visibility
      const { buildAgentBridgeInspection } = await import("../src/runtimeInspector.js");
      const view = buildAgentBridgeInspection({
        AGENT_BRIDGE_DB_PATH: path,
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: routine.chatKey,
        AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
        AGENT_BRIDGE_OWNER_KEY: routine.ownerKey,
      });
      expect(view.scheduledRoutines[0].recentOccurrence).toEqual(expect.objectContaining({
        runId: null,
        reasonCode: "pre_admission_failed",
      }));
    } finally {
      db.close();
    }
  });

  it("preserves once-routine disable on pre-admission failure without blind replay and allows manual recovery", async () => {
    const path = join(tmpdir(), `scheduled-once-recovery-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-once-recovery-test", runId: "process-test" });
    try {
      const routine = {
        ...routineFixture({ id: "once-routine-recover" }),
        schedule: { type: "once" as const, localDateTime: "2026-09-01T20:00" },
      };
      createScheduledRoutine(db, routine);

      let hookShouldFail = true;
      const runCli = vi.fn().mockImplementation(async (_cmd, _args, _cwd, opts) => {
        opts?.onEvent?.({
          type: "run.started",
          version: 1,
          id: "evt-start",
          runId: opts.eventContext.runId,
          timestamp: new Date().toISOString(),
          bot: "cursor",
          chatId: String(routine.chatKey),
          chatKey: routine.chatKey,
          command: "cursor",
          cwd: "/tmp",
          model: null,
        });
        opts?.onEvent?.({
          type: "run.completed",
          version: 1,
          id: "evt-done",
          runId: opts.eventContext.runId,
          timestamp: new Date().toISOString(),
          bot: "cursor",
          chatId: String(routine.chatKey),
          chatKey: routine.chatKey,
          text: "manual routine executed",
          sessionId: "sess-1",
        });
        return { stdout: "manual routine executed", stderr: "", exitCode: 0 };
      });

      const engine = new BridgeEngine({
        surfaceIdentity: "telegram:interactive",
        kind: "cursor",
        botConfig: { command: "cursor", modelPreference: [] },
        allowedUserIds: new Set(["42"]),
        executionMode: "safe",
        pollIntervalMs: 1000,
        workingDir: process.cwd(),
        hooks: {
          onBeforeExecute: async (p) => {
            if (hookShouldFail) throw new Error("Temporary pre-admission failure");
            return p;
          },
        },
      }, db, mockClient(), {
        runCli,
        runCliAsync: runCli,
        runProviderInvocation: async (_b, _p, _c, _i, _o, opts) => {
          await runCli("cursor", [], "/tmp", opts);
          return { text: "manual routine executed", sessionId: "sess-1", stopReason: "end_turn" };
        },
      } as any);

      const nowMs = Date.parse("2026-09-01T20:05:00.000Z");

      // First scan: once-routine is claimed and disabled, but pre-admission fails
      await scanScheduledRoutines(db, "telegram:interactive", async (r, intendedAt, occurrenceKey) => {
        const turn = buildScheduledInteractiveTurn(r, intendedAt, "42", occurrenceKey);
        return engine.handleInteractiveTurn(turn);
      }, nowMs);

      // Verify occurrence failed before Run admission
      const intendedAt = "2026-09-01T20:00:00.000Z";
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);
      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.status).toBe("failed");
      expect(evidence?.runId).toBeNull();

      // Verify the once-routine was disabled and is not blindly re-run on subsequent scan ticks
      const secondScanDispatch = vi.fn();
      await scanScheduledRoutines(db, "telegram:interactive", secondScanDispatch, nowMs + 5_000);
      expect(secondScanDispatch).not.toHaveBeenCalled();

      // Manual operator recovery: requestScheduledRoutineRun triggers an explicit run
      hookShouldFail = false;
      const requestedAt = requestScheduledRoutineRun(db, routine.id, "telegram:interactive", routine.chatKey, routine.ownerKey);

      await scanScheduledRoutines(db, "telegram:interactive", async (r, intendedAt, occKey) => {
        const turn = buildScheduledInteractiveTurn(r, intendedAt, "42", occKey);
        return engine.handleInteractiveTurn(turn);
      }, nowMs + 10_000);

      expect(runCli).toHaveBeenCalled();
      const manualKey = scheduledOccurrenceKey(routine.id, requestedAt, "manual");
      const manualEvidence = parseScheduledOccurrenceEvidence(db.getSetting(manualKey));
      expect(manualEvidence?.runId).toBeTruthy();
      const run = db.getRun(manualEvidence!.runId!);
      expect(run?.status).toBe("done");
    } finally {
      db.close();
    }
  });
});
