#!/usr/bin/env node
import Database from "better-sqlite3";
import { BridgeDb } from "../src/db.js";
import { requestRunContinuation } from "../src/runContinuation.js";
import type { RouteableBotKind } from "../src/types.js";

type EnvLike = Record<string, string | undefined>;

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function requestAgentBridgeWait(args: string[], env: EnvLike = process.env): string {
  const dbPath = required(env, "AGENT_BRIDGE_CONTEXT_DB");
  const originRunId = required(env, "AGENT_BRIDGE_RUN_ID");
  const surfaceIdentity = required(env, "AGENT_BRIDGE_SURFACE_IDENTITY");
  const chatKey = required(env, "AGENT_BRIDGE_CHAT_KEY");
  const provider = required(env, "AGENT_BRIDGE_PROVIDER") as RouteableBotKind;
  const reason = option(args, "--reason") ?? "";
  const afterRaw = option(args, "--after-seconds");
  const afterSeconds = Number(afterRaw);
  if (!Number.isInteger(afterSeconds)) throw new Error("--after-seconds requires an integer");

  const raw = new Database(dbPath, { fileMustExist: true });
  raw.pragma("foreign_keys = ON");
  const db = new BridgeDb(raw, { serviceId: "run-continuation-helper", runId: originRunId, leaseMs: 90_000 });
  try {
    const continuation = requestRunContinuation(db, {
      originRunId,
      surfaceIdentity,
      chatKey,
      provider,
      reason,
      afterSeconds,
    });
    return `Continuation scheduled for ${continuation.dueAt}. Finish this Run without promising the user to check manually.`;
  } finally {
    db.close();
  }
}

try {
  process.stdout.write(requestAgentBridgeWait(process.argv.slice(2)) + "\n");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-bridge-wait: ${message}\n`);
  process.exit(1);
}
