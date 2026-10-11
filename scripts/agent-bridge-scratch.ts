#!/usr/bin/env node
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  clearScratch,
  currentScratchRevision,
  readScratch,
  writeScratch,
  type ScratchFence,
  type ScratchIdentity,
} from "../src/scratchpad.js";

type EnvLike = Record<string, string | undefined>;

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function ifRevision(args: string[]): number {
  const index = args.indexOf("--if-revision");
  const raw = index === -1 ? undefined : args[index + 1];
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error("--if-revision <non-negative integer> is required");
  return Number(raw);
}

function requireExactArgs(command: "read" | "write" | "clear", args: string[]): void {
  if (command === "read" && args.length === 1) return;
  if ((command === "write" || command === "clear") && args.length === 3 && args[1] === "--if-revision" && /^\d+$/.test(args[2] ?? "")) return;
  throw new Error('usage: read | write --if-revision <n> (body on stdin) | clear --if-revision <n>');
}

export function runAgentBridgeScratch(args: string[], env: EnvLike = process.env, readStdin: () => string = () => readFileSync(0, "utf8")): string {
  const command = args[0];
  if (command !== "read" && command !== "write" && command !== "clear") {
    throw new Error('usage: read | write --if-revision <n> (body on stdin) | clear --if-revision <n>');
  }
  requireExactArgs(command, args);
  const identity: ScratchIdentity = {
    surfaceIdentity: required(env, "AGENT_BRIDGE_SURFACE_IDENTITY"),
    chatKey: required(env, "AGENT_BRIDGE_CHAT_KEY"),
  };
  const dbPath = required(env, "AGENT_BRIDGE_CONTEXT_DB");
  const db = new Database(dbPath, { fileMustExist: true, readonly: command === "read" });
  try {
    if (command === "read") {
      const scratch = readScratch(db, identity);
      const revision = scratch?.revision ?? currentScratchRevision(db, identity);
      if (!scratch) return `Scratchpad is empty. revision: ${revision}`;
      return `revision: ${scratch.revision}\nupdated: ${scratch.updatedAt} by Run ${scratch.updatedByRun} via ${scratch.provider}\n---\n${scratch.text}`;
    }
    const fence: ScratchFence = {
      runId: required(env, "AGENT_BRIDGE_RUN_ID"),
      serviceId: required(env, "AGENT_BRIDGE_LOCK_SERVICE_ID"),
      laneRunId: required(env, "AGENT_BRIDGE_LOCK_RUN_ID"),
      acquisitionId: required(env, "AGENT_BRIDGE_LOCK_ACQUISITION_ID"),
      provider: env.AGENT_BRIDGE_PROVIDER?.trim() || "unknown",
    };
    const expected = ifRevision(args);
    const next = command === "write"
      ? writeScratch(db, identity, fence, expected, readStdin())
      : clearScratch(db, identity, fence, expected);
    return command === "write" ? `Scratchpad written. revision: ${next.revision}` : `Scratchpad cleared. revision: ${next.revision}`;
  } finally {
    db.close();
  }
}

if (process.argv[1] && /agent-bridge-scratch\.ts$/.test(process.argv[1])) {
  try {
    process.stdout.write(runAgentBridgeScratch(process.argv.slice(2)) + "\n");
  } catch (error) {
    process.stderr.write(`agent-bridge-scratch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
