#!/usr/bin/env node
import Database from "better-sqlite3";
import { BridgeDb } from "../src/db.js";
import { requestRunContinuation } from "../src/runContinuation.js";
import { requestAgentBridgeOutcome } from "../src/runOutcome.js";
import type { RouteableBotKind } from "../src/types.js";

type EnvLike = Record<string, string | undefined>;
function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function option(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

/** Preserve the existing wait interface for older callers and read-only runs.
 * Eligible interactive Runs have a lane fence and record 'continue' as their outcome.
 */
export function requestAgentBridgeWait(args: string[], env: EnvLike = process.env): string {
  const hasOutcomeScope = Boolean(
    env.AGENT_BRIDGE_LOCK_SERVICE_ID && env.AGENT_BRIDGE_LOCK_RUN_ID && env.AGENT_BRIDGE_LOCK_ACQUISITION_ID
  );
  if (hasOutcomeScope) return requestAgentBridgeOutcome(["continue", ...args], env);

  const dbPath = required(env, "AGENT_BRIDGE_CONTEXT_DB");
  const originRunId = required(env, "AGENT_BRIDGE_RUN_ID");
  const surfaceIdentity = required(env, "AGENT_BRIDGE_SURFACE_IDENTITY");
  const chatKey = required(env, "AGENT_BRIDGE_CHAT_KEY");
  const provider = required(env, "AGENT_BRIDGE_PROVIDER") as RouteableBotKind;
  const reason = option(args, "--reason") ?? "";
  const afterRaw = option(args, "--after-seconds");
  const afterSeconds = Number(afterRaw);
  if (!Number.isInteger(afterSeconds)) throw new Error("--after-seconds requires an integer");

  const deliveryChatId = env.AGENT_BRIDGE_DELIVERY_CHAT_ID?.trim();
  const deliveryChatType = env.AGENT_BRIDGE_DELIVERY_CHAT_TYPE?.trim();
  const deliveryThreadId = env.AGENT_BRIDGE_DELIVERY_THREAD_ID?.trim();
  const delivery = deliveryChatId && deliveryChatType
    ? { chatId: deliveryChatId, chatType: deliveryChatType, ...(deliveryThreadId ? { threadId: deliveryThreadId } : {}) }
    : undefined;

  const raw = new Database(dbPath, { fileMustExist: true });
  raw.pragma("foreign_keys = ON");
  const db = new BridgeDb(raw, { serviceId: "run-continuation-helper", runId: originRunId, leaseMs: 90_000 });
  try {
    const continuation = requestRunContinuation(db, {
      originRunId, surfaceIdentity, chatKey, provider, reason, afterSeconds, delivery,
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
