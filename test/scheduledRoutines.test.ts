import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { ProviderFallbackChain } from "../src/providerFallback.js";
import { dispatchInteractiveWithFallback, setUserCliPreference } from "../src/interactiveBot.js";
import {
  buildScheduledInteractiveUpdate,
  claimScheduledRoutineOccurrence,
  createScheduledRoutine,
  deleteScheduledRoutine,
  disableScheduledRoutine,
  latestDueScheduledOccurrence,
  listScheduledRoutines,
  scanScheduledRoutines,
  type ScheduledRoutine,
} from "../src/scheduledRoutines.js";

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
  it("stores only an explicitly supplied agreed instruction and scopes management to its conversation", () => {
    const db = setup();
    createScheduledRoutine(db, weekly());
    createScheduledRoutine(db, weekly({ id: "other", chatKey: "999", name: "Other" }));

    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42")).toEqual([
      expect.objectContaining({ id: "routine-1", instruction: "Review current work and tell me the top three priorities.", enabled: true }),
    ]);

    expect(disableScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42")).toBe(true);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42")[0].enabled).toBe(false);
    expect(deleteScheduledRoutine(db, "routine-1", "telegram:interactive", "-100:42")).toBe(true);
    expect(listScheduledRoutines(db, "telegram:interactive", "-100:42")).toEqual([]);
    expect(listScheduledRoutines(db, "telegram:interactive", "999")).toHaveLength(1);
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

  it("resolves one-shot local time and rejects nonexistent DST wall times", () => {
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
  });

  it("claims one intended occurrence only once across repeated scans", () => {
    const db = setup();
    createScheduledRoutine(db, weekly());
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-31T06:00:00.000Z")).toBe(true);
    expect(claimScheduledRoutineOccurrence(db, "routine-1", "2026-08-31T06:00:00.000Z")).toBe(false);
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
    const update = buildScheduledInteractiveUpdate(routine, occurrence, "123");
    expect(update.message?.chat.id).toBe(-100);
    expect(update.message?.chat.type).toBe("supergroup");
    expect(update.message?.message_thread_id).toBe(42);
    expect(update.message?.from?.id).toBe(123);
    expect(update.message?.text).toContain(routine.instruction);

    let observedChatKey: string | null = null;
    setUserCliPreference(db, routine.chatKey, "codex");
    const fallbackChain = new ProviderFallbackChain(["codex"], db);
    await dispatchInteractiveWithFallback(update, routine.chatKey, {
      engines: {
        codex: {
          handleUpdate: async (_u, chatKey) => { observedChatKey = chatKey ?? null; },
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

  it("preserves a Discord snowflake chat key without numeric coercion", () => {
    const routine = weekly({
      id: "discord-routine",
      surfaceIdentity: "discord:interactive",
      chatKey: "123456789012345678",
    });
    const actor = "987654321098765432";
    const update = buildScheduledInteractiveUpdate(routine, "2026-08-31T06:00:00.000Z", actor);
    expect(String(update.message?.chat.id)).toBe(routine.chatKey);
    expect(String(update.message?.from?.id)).toBe(actor);
  });
});
