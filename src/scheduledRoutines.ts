/**
 * PURPOSE: Minimal durable schedule state for explicitly authorised companion routines.
 * The scheduler only determines when one stored instruction is due and claims each
 * intended occurrence once. Existing interactive/autonomy owners execute the work.
 * NEIGHBORS: src/index-interactive.ts, src/index-discord-interactive.ts, src/interactiveBot.ts
 */

import { createHash } from "node:crypto";
import type { BridgeDb } from "./db.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";
import { encodeScheduledOccurrenceEvidence, scheduledOccurrenceKey, type ScheduledOccurrenceKind } from "./scheduledRunCorrelation.js";

export type ScheduledRoutineKind = "companion" | "autonomous";
export type ScheduledRoutineSchedule =
  | { type: "once"; localDateTime: string }
  | { type: "weekly"; weekdays: number[]; time: string };

export interface ScheduledRoutine {
  id: string;
  name: string;
  instruction: string;
  kind: ScheduledRoutineKind;
  surfaceIdentity: string;
  chatKey: string;
  ownerKey: string;
  timezone: string;
  schedule: ScheduledRoutineSchedule;
  enabled: boolean;
  createdAt: string;
  /** Transport delivery coordinates, separate from canonical conversation identity. */
  delivery?: { chatId: string | number; chatType: string; threadId?: string | number };
}

export interface ScheduledOccurrence {
  intendedAt: string;
  stale: boolean;
}

export type ScheduledRoutineDispatch = (routine: ScheduledRoutine, intendedAt: string, occurrenceKey: string) => Promise<void>;

const ROUTINE_PREFIX = "scheduled-routine:v1:";
const TRIGGER_PREFIX = "scheduled-routine-trigger:v1:";
const MAX_NAME_CHARS = 120;
const MAX_INSTRUCTION_CHARS = 25_000;
const DEFAULT_CATCH_UP_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_SCAN_MS = 30_000;
const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function routineKey(id: string): string {
  return `${ROUTINE_PREFIX}${id}`;
}

function triggerKey(id: string): string {
  return `${TRIGGER_PREFIX}${id}`;
}

function bounded(value: string, label: string, max: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return normalized;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`invalid timezone: ${timezone}`);
  }
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = TIME_RE.exec(value);
  if (!match) throw new Error(`invalid local time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`invalid local time: ${value}`);
  return { hour, minute };
}

function parseLocalDateTime(value: string): LocalParts {
  const match = ISO_LOCAL_RE.exec(value);
  if (!match) throw new Error(`invalid local wall time: ${value}`);
  const parts: LocalParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) {
    throw new Error(`invalid local wall time: ${value}`);
  }
  const canonical = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  if (canonical.getUTCFullYear() !== parts.year || canonical.getUTCMonth() + 1 !== parts.month || canonical.getUTCDate() !== parts.day) {
    throw new Error(`invalid local wall time: ${value}`);
  }
  return parts;
}

function localParts(timestampMs: number, timezone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const fields = Object.fromEntries(formatter.formatToParts(new Date(timestampMs))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
  };
}

function sameLocal(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

function localWallTimeToUtc(parts: LocalParts, timezone: string): number {
  assertTimezone(timezone);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = wallAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const observed = localParts(candidate, timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const next = candidate + (wallAsUtc - observedAsUtc);
    if (next === candidate) break;
    candidate = next;
  }
  if (!sameLocal(localParts(candidate, timezone), parts)) {
    throw new Error("local wall time does not exist in the selected timezone");
  }
  return candidate;
}

function calendarDateAt(timestampMs: number, timezone: string): Pick<LocalParts, "year" | "month" | "day"> {
  const parts = localParts(timestampMs, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function previousCalendarDate(date: Pick<LocalParts, "year" | "month" | "day">, days: number): Pick<LocalParts, "year" | "month" | "day"> {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day - days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function weekday(date: Pick<LocalParts, "year" | "month" | "day">): number {
  const js = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return js === 0 ? 7 : js;
}

function validateRoutine(routine: ScheduledRoutine): ScheduledRoutine {
  const normalized: ScheduledRoutine = {
    ...routine,
    id: bounded(routine.id, "routine id", 100),
    name: bounded(routine.name, "routine name", MAX_NAME_CHARS),
    instruction: bounded(routine.instruction, "routine instruction", MAX_INSTRUCTION_CHARS),
    surfaceIdentity: bounded(routine.surfaceIdentity, "surface identity", 160),
    chatKey: bounded(routine.chatKey, "chat key", 200),
    ownerKey: bounded(routine.ownerKey, "owner key", 240),
    timezone: bounded(routine.timezone, "timezone", 100),
    createdAt: new Date(routine.createdAt).toISOString(),
  };
  assertTimezone(normalized.timezone);
  if (normalized.kind !== "companion" && normalized.kind !== "autonomous") throw new Error("invalid routine kind");
  if (normalized.schedule.type === "once") {
    const intendedMs = localWallTimeToUtc(parseLocalDateTime(normalized.schedule.localDateTime), normalized.timezone);
    if (intendedMs < Date.parse(normalized.createdAt)) throw new Error("one-shot schedule cannot predate routine creation");
  } else if (normalized.schedule.type === "weekly") {
    parseTime(normalized.schedule.time);
    const weekdays = [...new Set(normalized.schedule.weekdays)].sort((a, b) => a - b);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error("weekly schedule requires weekdays 1 through 7");
    }
    normalized.schedule = { ...normalized.schedule, weekdays };
  } else {
    throw new Error("invalid routine schedule");
  }
  return normalized;
}

function parseRoutine(value: string): ScheduledRoutine | null {
  try {
    const candidate = JSON.parse(value) as ScheduledRoutine;
    const routine = validateRoutine(candidate);
    if (routine.delivery) return routine;
    // Legacy v1 rows did not persist delivery. Decode once at the compatibility
    // boundary; all newly written rows carry delivery directly.
    if (routine.surfaceIdentity.startsWith("telegram:")) {
      try {
        const destination = scheduledTelegramDestination(routine);
        return { ...routine, delivery: { chatId: destination.chatId, chatType: destination.chatId < 0 ? "supergroup" : "private", ...(destination.threadId === undefined ? {} : { threadId: destination.threadId }) } };
      } catch {
        return { ...routine, delivery: { chatId: routine.chatKey, chatType: "private" } };
      }
    }
    if (routine.surfaceIdentity.startsWith("discord:")) return { ...routine, delivery: { chatId: routine.chatKey, chatType: "private" } };
    return null;
  } catch {
    return null;
  }
}

export function createScheduledRoutine(db: BridgeDb, routine: ScheduledRoutine): ScheduledRoutine {
  const normalized = parseRoutine(JSON.stringify(validateRoutine(routine)));
  if (!normalized) throw new Error("routine delivery coordinates are invalid");
  const result = db.raw.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(routineKey(normalized.id), JSON.stringify(normalized));
  if (result.changes !== 1) throw new Error(`scheduled routine already exists: ${normalized.id}`);
  return normalized;
}

/**
 * Parses one stored routine row, persisting the result when the legacy
 * decoder had to backfill `delivery` so that decode never runs again for
 * this row -- every later read and dispatch then finds `delivery` already
 * on the stored record instead of re-deriving it from `chatKey`.
 */
function normalizeStoredRoutine(db: BridgeDb, key: string, rawValue: string): ScheduledRoutine | null {
  const routine = parseRoutine(rawValue);
  if (!routine) return null;
  let storedHasDelivery: boolean;
  try {
    storedHasDelivery = Boolean((JSON.parse(rawValue) as { delivery?: unknown }).delivery);
  } catch {
    storedHasDelivery = false;
  }
  if (!storedHasDelivery) {
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(routine), key);
  }
  return routine;
}

/**
 * Factual route descriptor derived only from the known surface identity. It
 * never claims the live provider chain: whether a switch actually happens still
 * depends on the configured chain, provider availability and #946 safety rules.
 */
export function describeScheduledRoutineRoute(surfaceIdentity: string): string {
  const locked = /^telegram:(?!interactive$)([a-z0-9-]+)$/.exec(surfaceIdentity);
  if (locked) {
    return `provider-locked to ${locked[1]}: occurrences run only on ${locked[1]} with no cross-provider fallback. `
      + "For work that must continue when this provider is unavailable, create the routine from the unified interactive conversation instead.";
  }
  if (surfaceIdentity === "telegram:interactive" || surfaceIdentity === "discord:interactive") {
    return "unified interactive conversation: another provider can take over only when a fallback chain is configured and a provider is available; this is not guaranteed.";
  }
  return "route is not a recognised interactive surface; provider fallback is not asserted.";
}

export function listScheduledRoutines(
  db: BridgeDb,
  surfaceIdentity?: string,
  chatKey?: string,
  ownerKey?: string,
): ScheduledRoutine[] {
  const rows = db.raw.prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key ASC")
    .all(`${ROUTINE_PREFIX}%`) as Array<{ key: string; value: string }>;
  return rows
    .map((row) => normalizeStoredRoutine(db, row.key, row.value))
    .filter((routine): routine is ScheduledRoutine => !!routine)
    .filter((routine) => surfaceIdentity === undefined || routine.surfaceIdentity === surfaceIdentity)
    .filter((routine) => chatKey === undefined || routine.chatKey === chatKey)
    .filter((routine) => ownerKey === undefined || routine.ownerKey === ownerKey);
}

function replaceRoutine(db: BridgeDb, routine: ScheduledRoutine): void {
  db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run(JSON.stringify(validateRoutine(routine)), routineKey(routine.id));
}

export function disableScheduledRoutine(db: BridgeDb, id: string, surfaceIdentity: string, chatKey: string, ownerKey?: string): boolean {
  const routine = listScheduledRoutines(db, surfaceIdentity, chatKey, ownerKey).find((item) => item.id === id);
  if (!routine) return false;
  replaceRoutine(db, { ...routine, enabled: false });
  return true;
}

export type ScheduledRoutineUpdate = Partial<
  Pick<ScheduledRoutine, "name" | "instruction" | "kind" | "timezone" | "schedule" | "enabled">
>;

export function updateScheduledRoutine(
  db: BridgeDb,
  id: string,
  surfaceIdentity: string,
  chatKey: string,
  ownerKey: string,
  patch: ScheduledRoutineUpdate,
): ScheduledRoutine {
  const routine = listScheduledRoutines(db, surfaceIdentity, chatKey, ownerKey).find((item) => item.id === id);
  if (!routine) throw new Error(`routine not found in this conversation: ${id}`);
  const normalized = parseRoutine(JSON.stringify(validateRoutine({ ...routine, ...patch })));
  if (!normalized) throw new Error("routine delivery coordinates are invalid");
  db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(normalized), routineKey(id));
  return normalized;
}

export function deleteScheduledRoutine(db: BridgeDb, id: string, surfaceIdentity: string, chatKey: string, ownerKey?: string): boolean {
  const routine = listScheduledRoutines(db, surfaceIdentity, chatKey, ownerKey).find((item) => item.id === id);
  if (!routine) return false;
  return db.raw.prepare("DELETE FROM settings WHERE key = ?").run(routineKey(id)).changes === 1;
}

export function claimScheduledRoutineOccurrence(
  db: BridgeDb,
  id: string,
  intendedAt: string,
  kind: ScheduledOccurrenceKind = "scheduled",
): boolean {
  const claimedAt = new Date().toISOString();
  const result = db.raw.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .run(scheduledOccurrenceKey(id, intendedAt, kind), encodeScheduledOccurrenceEvidence(claimedAt));
  return result.changes === 1;
}

function claimScheduledRoutineForDispatch(
  db: BridgeDb,
  routine: ScheduledRoutine,
  intendedAt: string,
): string | null {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(routineKey(routine.id)) as { value: string } | undefined;
    const current = row ? parseRoutine(row.value) : null;
    if (!current || !current.enabled) return null;
    if (current.surfaceIdentity !== routine.surfaceIdentity || current.chatKey !== routine.chatKey || current.ownerKey !== routine.ownerKey) return null;
    if (!claimScheduledRoutineOccurrence(db, routine.id, intendedAt)) return null;
    if (current.schedule.type === "once") replaceRoutine(db, { ...current, enabled: false });
    return scheduledOccurrenceKey(routine.id, intendedAt);
  });
}

export function latestDueScheduledOccurrence(
  routine: ScheduledRoutine,
  nowMs = Date.now(),
  catchUpMs = DEFAULT_CATCH_UP_MS,
): ScheduledOccurrence | null {
  if (!routine.enabled) return null;
  let intendedMs: number | null = null;
  if (routine.schedule.type === "once") {
    intendedMs = localWallTimeToUtc(parseLocalDateTime(routine.schedule.localDateTime), routine.timezone);
    if (intendedMs > nowMs) return null;
  } else {
    const { hour, minute } = parseTime(routine.schedule.time);
    const createdMs = Date.parse(routine.createdAt);
    const currentDate = calendarDateAt(nowMs, routine.timezone);
    for (let daysBack = 0; daysBack <= 7; daysBack += 1) {
      const date = previousCalendarDate(currentDate, daysBack);
      if (!routine.schedule.weekdays.includes(weekday(date))) continue;
      try {
        const candidate = localWallTimeToUtc({ ...date, hour, minute }, routine.timezone);
        if (candidate > nowMs) continue;
        if (candidate < createdMs) return null;
        intendedMs = candidate;
        break;
      } catch {
        // A recurring wall time can be nonexistent during a DST jump. Skip that occurrence.
      }
    }
    if (intendedMs === null) return null;
  }
  return {
    intendedAt: new Date(intendedMs).toISOString(),
    stale: nowMs - intendedMs > catchUpMs,
  };
}

/**
 * Requests an immediate, ad hoc dispatch of a routine's stored instruction, bypassing
 * its schedule. Collapses to the single most recent pending request if called again
 * before the next scan claims it. The owning routine's live scan/dispatch loop (not
 * this call) performs the actual run, so it reuses the existing delivery, fallback,
 * and autonomy-kind handling unchanged.
 */
export function requestScheduledRoutineRun(
  db: BridgeDb,
  id: string,
  surfaceIdentity: string,
  chatKey: string,
  ownerKey: string,
  requestedAt = new Date().toISOString(),
): string {
  const routine = listScheduledRoutines(db, surfaceIdentity, chatKey, ownerKey).find((item) => item.id === id);
  if (!routine) throw new Error(`routine not found in this conversation: ${id}`);
  const normalizedRequestedAt = new Date(requestedAt).toISOString();
  db.raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(triggerKey(id), normalizedRequestedAt);
  return normalizedRequestedAt;
}

function claimPendingManualTrigger(db: BridgeDb, id: string): string | null {
  return db.runInTransaction(() => {
    const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(triggerKey(id)) as { value: string } | undefined;
    if (!row) return null;
    db.raw.prepare("DELETE FROM settings WHERE key = ?").run(triggerKey(id));
    return row.value;
  });
}

export async function scanScheduledRoutines(
  db: BridgeDb,
  surfaceIdentity: string,
  dispatch: ScheduledRoutineDispatch,
  nowMs = Date.now(),
): Promise<void> {
  for (const routine of listScheduledRoutines(db, surfaceIdentity)) {
    const triggeredAt = claimPendingManualTrigger(db, routine.id);
    if (triggeredAt) {
      if (claimScheduledRoutineOccurrence(db, routine.id, triggeredAt, "manual")) {
        await dispatch(routine, triggeredAt, scheduledOccurrenceKey(routine.id, triggeredAt, "manual"));
      }
    }
    if (!routine.enabled) continue;
    const occurrence = latestDueScheduledOccurrence(routine, nowMs);
    if (!occurrence) continue;
    const occurrenceKey = claimScheduledRoutineForDispatch(db, routine, occurrence.intendedAt);
    if (!occurrenceKey) continue;
    if (occurrence.stale) continue;
    await dispatch(routine, occurrence.intendedAt, occurrenceKey);
  }
}

export class ScheduledRoutineRunner {
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly db: BridgeDb,
    private readonly surfaceIdentity: string,
    private readonly dispatch: ScheduledRoutineDispatch,
    private readonly scanMs = DEFAULT_SCAN_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.scanning) return;
      this.scanning = true;
      void scanScheduledRoutines(this.db, this.surfaceIdentity, this.dispatch)
        .catch((error) => console.error("[scheduled-routines] scan failed", error))
        .finally(() => { this.scanning = false; });
    };
    tick();
    this.timer = setInterval(tick, this.scanMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

function deterministicSyntheticId(routineId: string, occurrenceKey: string): number {
  const digest = createHash("sha256").update(`${routineId}\0${occurrenceKey}`).digest();
  return -Math.max(1, digest.readUIntBE(0, 6));
}

export function scheduledTelegramDestination(routine: ScheduledRoutine): { chatId: number; threadId?: number } {
  const match = /^(-?\d+)(?::(\d+))?$/.exec(routine.chatKey);
  if (!match) throw new Error("scheduled Telegram routine has invalid canonical chat key");
  const chatId = Number(match[1]);
  const threadId = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(chatId) || (threadId !== undefined && !Number.isSafeInteger(threadId))) {
    throw new Error("scheduled Telegram routine has unsafe canonical chat key");
  }
  return { chatId, ...(threadId === undefined ? {} : { threadId }) };
}

export function buildScheduledInteractiveTurn(
  routine: ScheduledRoutine,
  intendedAt: string,
  authorizedUserId: string,
  claimedOccurrenceKey = scheduledOccurrenceKey(routine.id, intendedAt),
): InteractiveTurnInput {
  // Delivery must already be on the stored record by the time dispatch runs
  // (listScheduledRoutines() persists the legacy-decoder's backfill on
  // first read) -- this boundary never reconstructs it from chatKey itself,
  // so a delivery-less routine fails closed via the per-surface checks below.
  const syntheticId = deterministicSyntheticId(routine.id, claimedOccurrenceKey);
  const text = [
    `[Scheduled routine: ${routine.name}]`,
    `This instruction was explicitly authorised earlier and was scheduled for ${intendedAt}.`,
    "Carry out the stored instruction now using the current conversation context.",
    "Do not create, edit, disable, or delete scheduled routines from this triggered Run.",
    "",
    routine.instruction,
  ].join("\n");
  const messageId = `scheduled:${routine.id}:${claimedOccurrenceKey}:${syntheticId}`;

  if (routine.surfaceIdentity.startsWith("telegram:")) {
    const destination = routine.delivery;
    if (!destination) throw new Error("scheduled Telegram routine has no delivery coordinates");
    if (!/^-?\d+$/.test(authorizedUserId)) throw new Error("scheduled Telegram routine has invalid authorised user");
    return {
      surfaceIdentity: routine.surfaceIdentity,
      chatKey: routine.chatKey,
      actorId: authorizedUserId,
      messageId,
      text,
      scheduledOccurrenceKey: claimedOccurrenceKey,
      ...(destination.threadId === undefined ? {} : { threadId: String(destination.threadId) }),
      delivery: { chatId: destination.chatId, chatType: destination.chatType },
      attachments: [],
    };
  }
  if (routine.surfaceIdentity.startsWith("discord:")) {
    if (!routine.delivery) throw new Error("scheduled Discord routine has no delivery coordinates");
    return { surfaceIdentity: routine.surfaceIdentity, chatKey: routine.chatKey, actorId: authorizedUserId, messageId, text, scheduledOccurrenceKey: claimedOccurrenceKey, delivery: routine.delivery, attachments: [] };
  }
  throw new Error(`unsupported scheduled routine surface: ${routine.surfaceIdentity}`);
}
