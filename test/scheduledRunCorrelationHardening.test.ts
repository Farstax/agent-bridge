import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  buildScheduledInteractiveTurn,
  claimScheduledRoutineOccurrence,
  createScheduledRoutine,
  deleteScheduledRoutine,
  type ScheduledRoutine,
} from "../src/scheduledRoutines.js";
import {
  linkScheduledOccurrenceRun,
  parseScheduledOccurrenceEvidence,
  scheduledOccurrenceKey,
} from "../src/scheduledRunCorrelation.js";

const paths: string[] = [];

function dbPath(label: string): string {
  const path = join(tmpdir(), `${label}-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return path;
}

function routineFixture(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "hardening-correlation",
    name: "Correlation hardening",
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

async function executeScheduledTurn(
  db: ReturnType<typeof openDb>,
  routine: ScheduledRoutine,
  intendedAt: string,
  occurrenceKey: string,
) {
  const runCli = vi.fn().mockResolvedValue(JSON.stringify({
    type: "result",
    result: "ROUTINE_TEST_OK",
    session_id: "scheduled-session",
  }));
  const engine = new BridgeEngine({
    surfaceIdentity: routine.surfaceIdentity,
    kind: "claude",
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    pollIntervalMs: 1000,
  }, db, mockClient(), { runCli });
  await engine.handleInteractiveTurn(buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey));
}

afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already removed */ }
});

describe("scheduled Run correlation hardening", () => {
  it("does not attach an unrelated same-chat Run to the scheduled occurrence", async () => {
    const path = dbPath("scheduled-correlation-unrelated");
    const db = openDb(path, { serviceId: "scheduled-correlation-unrelated", runId: "process-test" });
    try {
      const routine = routineFixture({ id: "unrelated-run" });
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:00:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);

      db.insertRun("manual-run", routine.chatKey, "claude");
      expect(db.updateRunCompleted("manual-run", "manual", null)).toBe(true);

      await executeScheduledTurn(db, routine, intendedAt, occurrenceKey);

      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.runId).toBeTruthy();
      expect(evidence?.runId).not.toBe("manual-run");
      expect(db.getRun(evidence!.runId!)).toEqual(expect.objectContaining({
        chat_id: routine.chatKey,
        status: "done",
      }));
    } finally {
      db.close();
    }
  });

  it("ignores more than 32 stale legacy dispatch rows and still links the exact occurrence", async () => {
    const path = dbPath("scheduled-correlation-legacy-dispatch");
    const db = openDb(path, { serviceId: "scheduled-correlation-legacy-dispatch", runId: "process-test" });
    try {
      const routine = routineFixture({ id: "many-dispatches" });
      createScheduledRoutine(db, routine);
      const intendedAt = "2026-09-01T20:00:00.000Z";
      expect(claimScheduledRoutineOccurrence(db, routine.id, intendedAt)).toBe(true);
      const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);

      for (let index = 0; index < 40; index += 1) {
        db.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
          `scheduled-routine-dispatch:v1:legacy-${String(index).padStart(2, "0")}`,
          JSON.stringify({ routineId: `legacy-${index}`, chatKey: `other-${index}`, state: "queued" }),
        );
      }

      await executeScheduledTurn(db, routine, intendedAt, occurrenceKey);
      const evidence = parseScheduledOccurrenceEvidence(db.getSetting(occurrenceKey));
      expect(evidence?.runId).toBeTruthy();
      expect(db.getRun(evidence!.runId!)).toEqual(expect.objectContaining({ status: "done" }));
    } finally {
      db.close();
    }
  });

  it("preserves queued occurrence identity across routine deletion and database reopen", () => {
    const path = dbPath("scheduled-correlation-deleted-routine");
    const routine = routineFixture({ id: "deleted-after-queue", chatKey: "200" });
    const intendedAt = "2026-09-01T20:00:00.000Z";
    const occurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt);

    const before = openDb(path, { serviceId: "scheduled-correlation-before", runId: "process-before" });
    createScheduledRoutine(before, routine);
    expect(claimScheduledRoutineOccurrence(before, routine.id, intendedAt)).toBe(true);
    const turn = buildScheduledInteractiveTurn(routine, intendedAt, "42", occurrenceKey);
    before.enqueueMsg(routine.surfaceIdentity, routine.chatKey, {
      prompt: turn.text,
      chatId: turn.delivery.chatId,
      chatType: turn.delivery.chatType,
      scheduledOccurrenceKey: turn.scheduledOccurrenceKey,
    });
    expect(deleteScheduledRoutine(before, routine.id, routine.surfaceIdentity, routine.chatKey, routine.ownerKey)).toBe(true);
    before.close();

    const after = openDb(path, { serviceId: "scheduled-correlation-after", runId: "process-after" });
    try {
      const handle = after.acquireLock(routine.surfaceIdentity, routine.chatKey);
      expect(handle).not.toBeNull();
      const claimed = after.claimNextPendingMsg(handle!);
      expect(claimed?.scheduledOccurrenceKey).toBe(occurrenceKey);

      after.insertRun("queued-run", routine.chatKey, "codex");
      expect(linkScheduledOccurrenceRun(after, claimed!.scheduledOccurrenceKey!, "queued-run")).toBe(true);
      expect(parseScheduledOccurrenceEvidence(after.getSetting(occurrenceKey))?.runId).toBe("queued-run");

      expect(after.completePendingMsg(handle!, claimed!.id)).toBe(true);
      expect(after.unlock(handle!)).toBe(true);
    } finally {
      after.close();
    }
  });
});
