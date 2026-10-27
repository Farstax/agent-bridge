import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import {
  MAX_CONSECUTIVE_AGENT_CONTINUATIONS,
  RunContinuationLimitError,
  claimContinuationLimitNotice,
  linkRunContinuationRun,
  listRunContinuations,
  requestRunContinuation,
} from "../src/runContinuation.js";
import { readRunOutcome, requestAgentBridgeOutcome, requestAgentBridgeWait } from "../src/runOutcome.js";

const dirs: string[] = [];
const scope = { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" };
const base = { ...scope, provider: "codex" as const, reason: "CI pending", afterSeconds: 60, delivery: { chatId: "chat-1", chatType: "private" } };

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chain-limit-")); dirs.push(dir);
  return join(dir, "bridge.sqlite");
}
function open(path: string) { return openDb(path, { serviceId: "chain-test", runId: "process" }); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Db = ReturnType<typeof open>;
/** Admit `runId` as the successor Run of the previous continuation, exactly as the engine does. */
function admitContinuationRun(db: Db, runId: string, previousContinuationId: string | null, provider: "codex" | "claude" = "codex") {
  db.insertRun(runId, scope, provider);
  if (previousContinuationId) expect(linkRunContinuationRun(db, previousContinuationId, runId)).toBe(true);
}
/** Builds a chain of `count` agent-initiated continuations; returns the id of the last. */
function buildChain(db: Db, count: number, start = 0): string | null {
  let previous: string | null = start === 0 ? null : `run-${start - 1}`;
  for (let i = start; i < start + count; i += 1) {
    const runId = `run-${i}`;
    admitContinuationRun(db, runId, previous);
    requestRunContinuation(db, { ...base, originRunId: runId });
    previous = runId;
  }
  return previous;
}

describe("consecutive agent-initiated continuation limit", () => {
  it("allows exactly 20 consecutive continuations and refuses the 21st atomically", () => {
    expect(MAX_CONSECUTIVE_AGENT_CONTINUATIONS).toBe(20);
    const db = open(dbPath());
    const last = buildChain(db, 20)!;
    admitContinuationRun(db, "run-20", last);
    expect(() => requestRunContinuation(db, { ...base, originRunId: "run-20" })).toThrow(RunContinuationLimitError);
    expect(listRunContinuations(db).filter((c) => c.originRunId === "run-20")).toHaveLength(0);
    expect(listRunContinuations(db)).toHaveLength(20);
    db.close();
  });

  it("is not reset by agent-generated continuation Runs, provider changes or restarts", () => {
    const path = dbPath();
    let db = open(path);
    buildChain(db, 10);
    db.close();
    db = open(path); // restart
    // The Run that follows continuation 9 is served by a different provider after fallback.
    admitContinuationRun(db, "run-10", "run-9", "claude");
    for (let i = 10; i < 20; i += 1) {
      const runId = `run-${i}`;
      if (i > 10) admitContinuationRun(db, runId, `run-${i - 1}`, i % 2 ? "claude" : "codex");
      requestRunContinuation(db, { ...base, originRunId: runId, provider: i % 2 || i === 10 ? "claude" : "codex" });
    }
    db.close();
    db = open(path); // second restart at the boundary
    admitContinuationRun(db, "run-20", "run-19", "codex");
    expect(() => requestRunContinuation(db, { ...base, originRunId: "run-20" })).toThrow(/continuation limit/i);
    db.close();
  });

  it("resets only for a Run with no continuation provenance (owner message or independent origin)", () => {
    const db = open(dbPath());
    const last = buildChain(db, 20)!;
    admitContinuationRun(db, "run-20", last);
    expect(() => requestRunContinuation(db, { ...base, originRunId: "run-20" })).toThrow(RunContinuationLimitError);
    // A fresh owner message (or scheduled routine) creates a Run with no continuation link.
    db.insertRun("run-owner", scope, "codex");
    const fresh = requestRunContinuation(db, { ...base, originRunId: "run-owner" });
    expect(fresh.state).toBe("pending");
    // The new chain counts from one again.
    admitContinuationRun(db, "run-owner-2", "run-owner");
    expect(requestRunContinuation(db, { ...base, originRunId: "run-owner-2" }).originRunId).toBe("run-owner-2");
    db.close();
  });

  it("does not count capacity-wait retries as new continuations but preserves the chain depth", () => {
    const db = open(dbPath());
    const last = buildChain(db, 19)!; // depth 19
    admitContinuationRun(db, "run-19", last);
    // The depth-19 Run fails on capacity; the same logical wait is requested repeatedly.
    for (let i = 0; i < 5; i += 1) {
      requestRunContinuation(db, { ...base, originRunId: "run-19", continuationId: "capacity-wait:7", capacityWait: true, afterSeconds: 300 });
    }
    const cap = listRunContinuations(db).find((c) => c.id === "capacity-wait:7")!;
    expect(cap.capacityWait).toBe(true);
    // The retried Run is a successor of the capacity wait, not a new agent continuation.
    db.insertRun("run-19-retry", scope, "codex");
    db.raw.prepare("UPDATE bridge_runs SET status = 'failed' WHERE run_id = 'run-19'").run();
    const claimed = { ...cap, state: "claimed" as const };
    db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(claimed), `run-continuation:v1:${cap.id}`);
    expect(linkRunContinuationRun(db, cap.id, "run-19-retry")).toBe(true);
    // Depth 19 + this agent continuation = 20: allowed; one more is refused.
    expect(requestRunContinuation(db, { ...base, originRunId: "run-19-retry" }).state).toBe("pending");
    admitContinuationRun(db, "run-20", "run-19-retry");
    expect(() => requestRunContinuation(db, { ...base, originRunId: "run-20" })).toThrow(RunContinuationLimitError);
    db.close();
  });

  it("is serialised across connections so racing 21st requests are both refused", () => {
    const path = dbPath();
    const a = open(path);
    const last = buildChain(a, 20)!;
    admitContinuationRun(a, "run-20", last);
    const b = open(path);
    expect(() => requestRunContinuation(a, { ...base, originRunId: "run-20" })).toThrow(RunContinuationLimitError);
    expect(() => requestRunContinuation(b, { ...base, originRunId: "run-20" })).toThrow(RunContinuationLimitError);
    expect(listRunContinuations(b)).toHaveLength(20);
    a.close(); b.close();
  });

  it("refuses through the provider helper without recording a continue outcome, blocks the Run and leaves a one-shot owner notice", () => {
    const path = dbPath();
    const db = open(path);
    const last = buildChain(db, 20)!;
    admitContinuationRun(db, "run-20", last);
    db.raw.prepare("UPDATE bridge_runs SET status = 'running' WHERE run_id = 'run-20'").run();
    const lock = db.acquireLock(scope.surfaceIdentity, scope.chatKey);
    if (!lock) throw new Error("missing fixture lane lock");
    const env = {
      AGENT_BRIDGE_LOCK_SERVICE_ID: lock.serviceId,
      AGENT_BRIDGE_LOCK_RUN_ID: lock.runId,
      AGENT_BRIDGE_LOCK_ACQUISITION_ID: lock.acquisitionId,
      AGENT_BRIDGE_CONTEXT_DB: path,
      AGENT_BRIDGE_RUN_ID: "run-20",
      AGENT_BRIDGE_SURFACE_IDENTITY: scope.surfaceIdentity,
      AGENT_BRIDGE_CHAT_KEY: scope.chatKey,
      AGENT_BRIDGE_PROVIDER: "codex",
      AGENT_BRIDGE_DELIVERY_CHAT_ID: "chat-1",
      AGENT_BRIDGE_DELIVERY_CHAT_TYPE: "private",
    };
    expect(() => requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "still waiting"], env))
      .toThrow(/continuation limit/i);
    expect(readRunOutcome(db, "run-20")?.status).toBe("blocked");
    expect(listRunContinuations(db)).toHaveLength(20);
    // The legacy wait alias shares the same boundary.
    expect(() => requestAgentBridgeWait(["--after-seconds", "60", "--reason", "again"], env)).toThrow(/continuation limit|already recorded/i);
    expect(readRunOutcome(db, "run-20")?.status).toBe("blocked");
    const notice = claimContinuationLimitNotice(db, "run-20");
    expect(notice).toMatchObject({ surfaceIdentity: scope.surfaceIdentity, chatKey: scope.chatKey });
    expect(claimContinuationLimitNotice(db, "run-20")).toBeNull();
    db.close();
  });
});
