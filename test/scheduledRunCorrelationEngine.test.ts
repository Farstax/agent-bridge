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
  type ScheduledRoutine,
} from "../src/scheduledRoutines.js";
import { parseScheduledOccurrenceEvidence, scheduledOccurrenceKey } from "../src/scheduledRunCorrelation.js";

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

afterEach(() => {
  for (const path of paths.splice(0)) try { rmSync(path); } catch {}
});

describe("authoritative scheduled Run correlation", () => {
  it("carries one claimed occurrence through BridgeEngine to its exact terminal Run", async () => {
    const path = join(tmpdir(), `scheduled-run-correlation-${Date.now()}-${Math.random()}.sqlite`);
    paths.push(path);
    const db = openDb(path, { serviceId: "scheduled-correlation-test", runId: "process-test" });
    try {
      const routine: ScheduledRoutine = {
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
      };
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
});
