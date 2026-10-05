import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchInteractiveTurnWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import {
  buildScheduledInteractiveTurn,
  claimScheduledRoutineOccurrence,
  createScheduledRoutine,
  deleteScheduledRoutine,
  disableScheduledRoutine,
  latestDueScheduledOccurrence,
  listScheduledRoutines,
  requestScheduledRoutineRun,
  scanScheduledRoutines,
  updateScheduledRoutine,
  type ScheduledRoutine,
} from "../src/scheduledRoutines.js";
import { parseScheduledOccurrenceEvidence, scheduledOccurrenceKey } from "../src/scheduledRunCorrelation.js";

const paths: string[] = [];

function setup() {
  const path = join(tmpdir(), `scheduled-routines-${Date.now()}-${Math.random()}.sqlite`);
  paths.push(path);
  return openDb(path, { serviceId: "scheduled-routine-test", runId: "test-process" });
}

function weekly(overrides: Partial<ScheduledRoutine> = {}): ScheduledRoutine {
  return {
    id: "routine-1",
    name: "Morning priorities",
    instruction: "Review current work and tell me the top three priorities.",
    kind: "companion",
    surfaceIdentity: "telegram:interactive",
    chatKey: "-100:42",
    ownerKey: "owner:test",
    timezone: "Europe/Madrid",
    schedule: { type: "weekly", weekdays: [1, 2, 3, 4, 5], time: "08:00" },
    enabled: true,
    createdAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const path of paths.splice(0)) try { rmSync(path); } catch { /* already removed */ }
});

describe("scheduled companion routines", () => {
  it("stores only an explicitly supplied agreed instruction and scopes management to its conversation owner", () => {
    const db = setup();
    createScheduledRoutine(db, weekly());
    createScheduledRoutine(db, weekly({ id: "other-chat", chatKey: "999", name: "Other chat" }));
    createScheduledRoutine(db, weekly({ id: "other-owner", ownerKey: "owner:other", name: "Other owner" }));

    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:test")).toEqual([
      expect.objectContaining({ id: "routine-1", instruction: "Review current work and tell me the top three priorities.", enabled: true }),
    ]);
    expect(disableScheduledRoutine(db, "other-owner", "telegram:interactive", "-100:42", "owner:test")).toBe(false);
    expect(deleteScheduledRoutine(db, "other-owner", "telegram:interactive", "-100:42", "owner:test")).toBe(false);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:other")).toHaveLength(1);

    expect(disableScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test")).toBe(true);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:test")[0].enabled).toBe(false);
    expect(deleteScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test")).toBe(true);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:test")).toEqual([]);
    expect(listScheduledRoutines(db, "telegram:interactive", "999", "owner:test")).toHaveLength(1);
    db.close();
  });

  it("resolves an explicit local recurring schedule in its timezone", () => {
    const due = latestDueScheduledOccurrence(weekly(), Date.parse("2026-08-31T06:00:30.000Z"));
    expect(due).toEqual({ intendedAt: "2026-08-31T06:00:00.000Z", stale: false });
  });

  it("does not catch up a recurring occurrence that predates routine creation", () => {
    const routine = weekly({ createdAt: "2026-08-31T06:30:00.000Z" });
    expect(latestDueScheduledOccurrence(routine, Date.parse("2026-08-31T06:31:00.000Z"))).toBeNull();
  });

  it("resolves one-shot local time and rejects nonexistent or pre-authority wall times", () => {
    const routine = weekly({
      schedule: { type: "once", localDateTime: "2026-08-30T10:00" },
    });
    expect(latestDueScheduledOccurrence(routine, Date.parse("2026-08-30T08:01:00.000Z"))).toEqual({
      intendedAt: "2026-08-30T08:00:00.000Z",
      stale: false,
    });
    expect(() => createScheduledRoutine(setup(), weekly({
      id: "bad-dst",
      schedule: { type: "once", localDateTime: "2026-03-29T02:30" },
    }))).toThrow(/time|timezone|wall/i);
    expect(() => createScheduledRoutine(setup(), weekly({
      id: "before-authority",
      createdAt: "2026-08-30T08:01:00.000Z",
      schedule: { type: "once", localDateTime: "2026-08-30T10:00" },
    }))).toThrow(/predate routine creation/);
  });

  it("claims one intended occurrence only once across repeated scans", () => {
    const db = setup();
    createScheduledRoutine(db, weekly());
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-31T06:00:00.000Z")).toBe(true);
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-31T06:00:00.000Z")).toBe(false);
    db.close();
  });

  it("persists the claimed occurrence key through the pending queue", () => {
    const db = setup();
    const intendedAt = "2026-08-31T06:00:00.000Z";
    expect(claimScheduledRoutineOccurrence(db, "routine-1", intendedAt)).toBe(true);
    const key = scheduledOccurrenceKey("routine-1", intendedAt);
    const evidence = parseScheduledOccurrenceEvidence(db.getSetting(key));
    expect(evidence).toEqual(expect.objectContaining({ version: 1, runId: null }));

    db.enqueueMsg("telegram:interactive", "-100:42", {
      prompt: "scheduled prompt",
      chatId: -100,
      threadId: 42,
      chatType: "supergroup",
      userId: 123,
      scheduledOccurrenceKey: key,
    });
    const handle = db.acquireLock("telegram:interactive", "-100:42");
    expect(handle).not.toBeNull();
    const claimed = db.claimNextPendingMsg(handle!);
    expect(claimed?.scheduledOccurrenceKey).toBe(key);
    db.close();
  });

  it("fires a one-shot routine once then disables it, and skips stale one-shots", async () => {
    const db = setup();
    const dispatch = vi.fn(async () => undefined);
    createScheduledRoutine(db, weekly({
      schedule: { type: "once", localDateTime: "2026-08-30T10:00" },
    }));

    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-30T08:01:00.000Z"));
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-30T08:02:00.000Z"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42")[0].enabled).toBe(false);

    createScheduledRoutine(db, weekly({
      id: "stale",
      schedule: { type: "once", localDateTime: "2026-08-30T11:00" },
    }));
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-30T17:01:00.000Z"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42").find((r) => r.id === "stale")?.enabled).toBe(false);
    db.close();
  });

  it("atomically rolls back a one-shot claim when disabling cannot commit", async () => {
    const db = setup();
    createScheduledRoutine(db, weekly({
      schedule: { type: "once", localDateTime: "2026-08-30T10:00" },
    }));
    db.raw.exec(`
      CREATE TRIGGER block_one_shot_disable
      BEFORE UPDATE ON settings
      WHEN OLD.key = 'scheduled-routine:v1:routine-1'
      BEGIN
        SELECT RAISE(ABORT, 'blocked one-shot disable');
      END;
    `);

    await expect(scanScheduledRoutines(
      db,
      "telegram:interactive",
      vi.fn(async () => undefined),
      Date.parse("2026-08-30T08:01:00.000Z"),
    )).rejects.toThrow(/blocked one-shot disable/);
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-30T08:00:00.000Z")).toBe(true);
    db.close();
  });

  it("normalizes a scheduled Telegram turn back into the exact canonical companion conversation", async () => {
    const db = setup();
    const routine = weekly();
    const occurrence = "2026-08-31T06:00:00.000Z";
    const turn = buildScheduledInteractiveTurn(routine, occurrence, "123");
    expect(turn.delivery).toEqual({ chatId: -100, chatType: "supergroup" });
    expect(turn.threadId).toBe("42");
    expect(turn.actorId).toBe("123");
    expect(turn.text).toContain(routine.instruction);

    let observedChatKey: string | null = null;
    setUserCliPreference(db, { surfaceIdentity: "telegram:interactive", chatKey: routine.chatKey }, "codex");
    const fallbackChain = new ProviderFallbackChain(["codex"], db, "telegram:interactive");
    await dispatchInteractiveTurnWithFallback(turn, {
      engines: {
        codex: {
          handleInteractiveTurn: async (input) => { observedChatKey = input.chatKey; },
          executeClaimedMessage: async () => "committed",
        },
      },
      fallbackChain,
      exhaustedChats: new Set(),
      db,
      notify: async () => undefined,
    });
    expect(observedChatKey).toBe("-100:42");
    db.close();
  });

  it("updates mutable fields in place while preserving id, createdAt, and scoping keys", () => {
    const db = setup();
    createScheduledRoutine(db, weekly());
    const updated = updateScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", {
      name: "Evening priorities",
      instruction: "Review today's work and flag anything blocking tomorrow.",
      schedule: { type: "weekly", weekdays: [6, 7], time: "18:30" },
    });
    expect(updated).toEqual(expect.objectContaining({
      id: "routine-1",
      name: "Evening priorities",
      instruction: "Review today's work and flag anything blocking tomorrow.",
      schedule: { type: "weekly", weekdays: [6, 7], time: "18:30" },
      createdAt: "2026-08-29T12:00:00.000Z",
      surfaceIdentity: "telegram:interactive",
      chatKey: "-100:42",
      ownerKey: "owner:test",
    }));
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:test")[0]).toEqual(updated);
    db.close();
  });

  it("can re-enable a fired one-shot routine with a new future time", () => {
    const db = setup();
    createScheduledRoutine(db, weekly({ schedule: { type: "once", localDateTime: "2026-08-30T10:00" } }));
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-30T08:00:00.000Z")).toBe(true);
    disableScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test");

    const updated = updateScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", {
      schedule: { type: "once", localDateTime: "2026-09-02T09:00" },
      enabled: true,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.schedule).toEqual({ type: "once", localDateTime: "2026-09-02T09:00" });
    db.close();
  });

  it("rejects update of a routine outside the caller's scope or that does not exist", () => {
    const db = setup();
    createScheduledRoutine(db, weekly({ id: "other-owner", ownerKey: "owner:other" }));
    expect(() => updateScheduledRoutine(db, "other-owner", "telegram:interactive", "-100:42", "owner:test", { name: "hijacked" }))
      .toThrow(/not found/);
    expect(() => updateScheduledRoutine(db, "missing", "telegram:interactive", "-100:42", "owner:test", { name: "x" }))
      .toThrow(/not found/);
    db.close();
  });

  it("accepts an instruction up to 25,000 characters and rejects over it", () => {
    const db = setup();
    createScheduledRoutine(db, weekly({ instruction: "x".repeat(25_000) }));
    expect(() => createScheduledRoutine(db, weekly({ id: "too-long", instruction: "x".repeat(25_001) })))
      .toThrow(/exceeds 25000 characters/);
    db.close();
  });

  it("dispatches an explicit manual run for a disabled routine but never its due schedule", async () => {
    const db = setup();
    const dispatch = vi.fn(async () => undefined);
    createScheduledRoutine(db, weekly());
    disableScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42", "owner:test");

    const triggeredAt = "2026-08-31T06:00:00.000Z";
    requestScheduledRoutineRun(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", triggeredAt);
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse(triggeredAt));
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-31T06:00:01.000Z"));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [routineArg, occurrence, occurrenceKey] = dispatch.mock.calls[0];
    expect(routineArg.id).toBe("routine-1");
    expect(occurrence).toBe(triggeredAt);
    expect(occurrenceKey).toBe(scheduledOccurrenceKey("routine-1", triggeredAt, "manual"));
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42", "owner:test")[0].enabled).toBe(false);
    db.close();
  });

  it("collapses repeated run requests before the next scan into a single dispatch", async () => {
    const db = setup();
    const dispatch = vi.fn(async () => undefined);
    createScheduledRoutine(db, weekly());

    requestScheduledRoutineRun(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", "2026-08-31T06:00:00.000Z");
    requestScheduledRoutineRun(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", "2026-08-31T06:00:01.000Z");
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2099-01-01T00:00:00.000Z"));

    expect(dispatch).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("dispatches a manual trigger and due occurrence in the same scan with independent identities", async () => {
    const db = setup();
    const dispatch = vi.fn(async () => undefined);
    createScheduledRoutine(db, weekly());

    const intendedAt = "2026-08-31T06:00:00.000Z";
    requestScheduledRoutineRun(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", intendedAt);
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse(intendedAt));
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-31T06:00:01.000Z"));

    expect(dispatch).toHaveBeenCalledTimes(2);
    const occurrenceKeys = dispatch.mock.calls.map(([, , key]) => key);
    expect(new Set(occurrenceKeys).size).toBe(2);
    expect(dispatch.mock.calls.map(([, occurrence]) => occurrence)).toEqual([intendedAt, intendedAt]);
    expect(occurrenceKeys).toContain(scheduledOccurrenceKey("routine-1", intendedAt));
    expect(occurrenceKeys).toContain(scheduledOccurrenceKey("routine-1", intendedAt, "manual"));
    expect(buildScheduledInteractiveTurn(weekly(), intendedAt, "123", occurrenceKeys[0]).messageId)
      .not.toBe(buildScheduledInteractiveTurn(weekly(), intendedAt, "123", occurrenceKeys[1]).messageId);
    db.close();
  });

  it("does not let a manual trigger defer a due occurrence past the catch-up boundary", async () => {
    const db = setup();
    const dispatch = vi.fn(async () => undefined);
    createScheduledRoutine(db, weekly());

    const boundary = "2026-08-31T12:00:00.000Z";
    requestScheduledRoutineRun(db, "routine-1", "telegram:interactive", "-100:42", "owner:test", boundary);
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse(boundary));
    await scanScheduledRoutines(db, "telegram:interactive", dispatch, Date.parse("2026-08-31T12:00:00.001Z"));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map(([, occurrence]) => occurrence)).toContain("2026-08-31T06:00:00.000Z");
    db.close();
  });

  it("rejects a run request for a routine outside the caller's scope or that does not exist", () => {
    const db = setup();
    createScheduledRoutine(db, weekly({ id: "other-owner", ownerKey: "owner:other" }));
    expect(() => requestScheduledRoutineRun(db, "other-owner", "telegram:interactive", "-100:42", "owner:test")).toThrow(/not found/);
    expect(() => requestScheduledRoutineRun(db, "missing", "telegram:interactive", "-100:42", "owner:test")).toThrow(/not found/);
  });

  it("preserves a Discord snowflake chat key without numeric coercion", () => {
    const routine = weekly({
      id: "discord-routine",
      surfaceIdentity: "discord:interactive",
      chatKey: "123456789012345678",
    });
    const actor = "987654321098765432";
    const turn = buildScheduledInteractiveTurn(routine, "2026-08-31T06:00:00.000Z", actor);
    expect(turn.delivery.chatId).toBe(routine.chatKey);
    expect(turn.actorId).toBe(actor);
    expect(typeof turn.delivery.chatId).toBe("string");
  });
});
