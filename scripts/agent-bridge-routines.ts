#!/usr/bin/env node
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { BridgeDb } from "../src/db.js";
import {
  createScheduledRoutine,
  deleteScheduledRoutine,
  disableScheduledRoutine,
  listScheduledRoutines,
  type ScheduledRoutineKind,
  type ScheduledRoutineSchedule,
} from "../src/scheduledRoutines.js";

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

function fail(message: string): never {
  throw new Error(message);
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return fail(`${name} is unavailable; align in the conversation and confirm the routine before creating it`);
  return value;
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return fail(`${name} requires a value`);
  return value;
}

function parseWeekdays(value: string): number[] {
  const days = value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean).map((part) => {
    if (/^[1-7]$/.test(part)) return Number(part);
    return WEEKDAYS[part] ?? fail(`invalid weekday: ${part}`);
  });
  if (!days.length) return fail("--weekly requires at least one weekday");
  return [...new Set(days)].sort((a, b) => a - b);
}

function scheduleFromArgs(args: string[]): ScheduledRoutineSchedule {
  const once = option(args, "--once");
  const weekly = option(args, "--weekly");
  const time = option(args, "--time");
  if (once && (weekly || time)) return fail("use either --once or --weekly with --time");
  if (once) return { type: "once", localDateTime: once };
  if (!weekly || !time) return fail("schedule requires --once YYYY-MM-DDTHH:mm or --weekly mon,tue,... --time HH:mm");
  return { type: "weekly", weekdays: parseWeekdays(weekly), time };
}

function openScopedDb(): { db: BridgeDb; surfaceIdentity: string; chatKey: string; ownerKey: string } {
  const dbPath = env("AGENT_BRIDGE_CONTEXT_DB");
  const surfaceIdentity = env("AGENT_BRIDGE_SURFACE_IDENTITY");
  const chatKey = env("AGENT_BRIDGE_CHAT_KEY");
  const ownerKey = env("AGENT_BRIDGE_OWNER_KEY");
  const raw = new Database(dbPath, { fileMustExist: true });
  raw.pragma("foreign_keys = ON");
  return {
    db: new BridgeDb(raw, { serviceId: "scheduled-routine-command", runId: randomUUID(), leaseMs: 90_000 }),
    surfaceIdentity,
    chatKey,
    ownerKey,
  };
}

function renderSchedule(schedule: ScheduledRoutineSchedule): string {
  return schedule.type === "once"
    ? `once ${schedule.localDateTime}`
    : `weekly ${schedule.weekdays.join(",")} at ${schedule.time}`;
}

function renderList(db: BridgeDb, surfaceIdentity: string, chatKey: string, ownerKey: string): string {
  const routines = listScheduledRoutines(db, surfaceIdentity, chatKey, ownerKey);
  if (!routines.length) return "No scheduled routines in this conversation.";
  return routines.map((routine) => [
    `${routine.id}\t${routine.enabled ? "active" : "disabled"}\t${routine.kind}\t${routine.name}`,
    `  ${renderSchedule(routine.schedule)} (${routine.timezone})`,
    `  ${routine.instruction}`,
  ].join("\n")).join("\n");
}

function main(args: string[]): string {
  const command = args[0];
  if (!command) return fail("usage: agent-bridge-routines <list|create|disable|delete> ...");
  const scope = openScopedDb();
  try {
    if (command === "list") return renderList(scope.db, scope.surfaceIdentity, scope.chatKey, scope.ownerKey);
    if (command === "disable" || command === "delete") {
      const id = args[1]?.trim();
      if (!id) return fail(`${command} requires a routine id`);
      const changed = command === "disable"
        ? disableScheduledRoutine(scope.db, id, scope.surfaceIdentity, scope.chatKey, scope.ownerKey)
        : deleteScheduledRoutine(scope.db, id, scope.surfaceIdentity, scope.chatKey, scope.ownerKey);
      if (!changed) return fail(`routine not found in this conversation: ${id}`);
      return command === "disable" ? `Disabled scheduled routine ${id}.` : `Deleted scheduled routine ${id}.`;
    }
    if (command !== "create") return fail(`unknown command: ${command}`);

    const name = option(args, "--name") ?? fail("create requires --name");
    const instruction = option(args, "--instruction") ?? fail("create requires --instruction");
    const timezone = option(args, "--timezone") ?? fail("create requires --timezone");
    const kind = (option(args, "--kind") ?? "companion") as ScheduledRoutineKind;
    if (kind !== "companion" && kind !== "autonomous") return fail("--kind must be companion or autonomous");
    if (kind === "autonomous" && scope.surfaceIdentity !== "telegram:interactive") {
      return fail("scheduled autonomy is currently supported only on the Telegram interactive surface with first-class autonomy supervision");
    }
    const routine = createScheduledRoutine(scope.db, {
      id: randomUUID(),
      name,
      instruction,
      kind,
      surfaceIdentity: scope.surfaceIdentity,
      chatKey: scope.chatKey,
      ownerKey: scope.ownerKey,
      timezone,
      schedule: scheduleFromArgs(args),
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    return `Created scheduled routine ${routine.id}: ${routine.name} (${renderSchedule(routine.schedule)}, ${routine.timezone}, ${routine.kind}).`;
  } finally {
    scope.db.close();
  }
}

try {
  process.stdout.write(main(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-routines: ${message}\n`);
  process.exit(1);
}
