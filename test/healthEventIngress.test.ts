import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  acceptHealthOpsEvent,
  executeHealthOpsRun,
  resumeDurablePendingHealthEvents,
  reconcileEventReceiptResult,
  healthEventExecutionStartedKey,
  serializeHealthEventExecutionStartedMarker,
  UnauthenticatedEventError,
  OversizedEventPayloadError,
  HealthOpsRunLaneUnavailableError,
  HEALTH_RUN_SURFACE,
  HEALTH_RUN_CHAT_KEY,
  type HealthOpsEventInput,
} from "../src/health/eventIngress.js";
import { reconcileAbandonedHealthLeases } from "../src/health/eventRecovery.js";
import type { HealthReport } from "../src/health/types.js";
import { ContinuationRepository } from "../src/repositories/continuationRepository.js";

/**
 * Issue #351 (corrected architecture, see issue body + PR #356 review
 * comments): external health event -> authenticated/idempotent durable
 * receipt -> ordinary owning Run (bridge_runs) -> main agent CLI turn ->
 * terminal Run/result -> receipt correlation. No work_item/work_job/
 * ops_check handler is involved anywhere in this path.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb(leaseMs = 90_000) {
  const dbPath = join(tmpdir(), `health-event-ingress-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-service", runId: "test-process", leaseMs });
  return { db, dbPath };
}

const EXPECTED_TOKEN = "test-shared-secret";

function redReport(overrides: Partial<HealthReport> = {}): HealthReport {
  return {
    pluginName: "content-crawler",
    status: "red",
    checks: [{ name: "queue-depth", status: "red", message: "queue backed up" }],
    summary: "content-crawler queue is backed up",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<HealthOpsEventInput> = {}): HealthOpsEventInput {
  return {
    eventId: "evt-1",
    idempotencyKey: "health:content-crawler:red:2026-08-12T00:00:00Z",
    occurredAt: "2026-08-12T00:00:00.000Z",
    report: redReport(),
    token: EXPECTED_TOKEN,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("acceptHealthOpsEvent", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb(300));
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  // ── Authentication ────────────────────────────────────────────────────────

  it("rejects an event with no configured expected token (fail closed)", () => {
    expect(() =>
      acceptHealthOpsEvent(db, makeEvent(), { expectedToken: undefined }),
    ).toThrow(UnauthenticatedEventError);
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  it("rejects an event whose token does not match the configured authority", () => {
    expect(() =>
      acceptHealthOpsEvent(db, makeEvent({ token: "wrong-token" }), { expectedToken: EXPECTED_TOKEN }),
    ).toThrow(UnauthenticatedEventError);
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  it("does not persist a receipt for a rejected unauthenticated event", () => {
    try {
      acceptHealthOpsEvent(db, makeEvent(), { expectedToken: "different-secret" });
    } catch { /* expected */ }
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  // ── Accept creates a durable receipt + ordinary owning Run ────────────────

  it("accepts an authenticated red-status event and creates exactly one receipt and one Run", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    expect(result.created).toBe(true);
    expect(result.runId).toBeTruthy();

    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("run_created");
    expect(receipt.source).toBe("health");
    expect(receipt.run_id).toBe(result.runId);

    const run = db.getRun(result.runId);
    expect(run.status).toBe("running");
    expect(run.chat_id).toBe(HEALTH_RUN_CHAT_KEY);
  });

  it("accepts events with no Worker persistence in the schema", () => {
    acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    for (const table of ["work_items", "work_jobs"]) {
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
  });

  // ── Idempotency / duplicate delivery ─────────────────────────────────────

  it("duplicate delivery of the same idempotency key creates one receipt and at most one writable Run", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const second = acceptHealthOpsEvent(db, makeEvent({ eventId: "evt-1-retry" }), { expectedToken: EXPECTED_TOKEN });

    expect(second.created).toBe(false);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.runId).toBe(first.runId);
  });

  it("a different idempotency key for the same plugin creates a second independent receipt and Run", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const second = acceptHealthOpsEvent(
      db,
      makeEvent({ idempotencyKey: "health:content-crawler:red:2026-08-12T01:00:00Z" }),
      { expectedToken: EXPECTED_TOKEN },
    );

    expect(second.receiptId).not.toBe(first.receiptId);
    expect(second.runId).not.toBe(first.runId);
  });

  // ── Restart-safe replay ───────────────────────────────────────────────────

  it("replaying acceptance after a simulated restart does not duplicate the Run", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const replay = acceptHealthOpsEvent(db, makeEvent({ eventId: "evt-1-replay" }), { expectedToken: EXPECTED_TOKEN });

    expect(replay.runId).toBe(first.runId);
  });

  it("a crash after receipt persistence but before Run creation leaves no orphan receipt state, and replay creates exactly one Run", () => {
    const originalInsertRun = db.insertRun.bind(db);
    let calls = 0;
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = ((...args: Parameters<typeof db.insertRun>) => {
      calls += 1;
      throw new Error("simulated crash after receipt persistence, before Run creation");
    }) as typeof db.insertRun;

    expect(() => acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN })).toThrow(
      "simulated crash",
    );
    expect(calls).toBe(1);

    // The receipt itself IS persisted (that's the point of "receipt-before-
    // execution durability") but is left correctly unlinked — status
    // 'received', run_id null — rather than orphaned in a state that would
    // suppress replay.
    const receipt = db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey);
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("received");
    expect(receipt!.run_id).toBeNull();

    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = originalInsertRun;

    const replay = acceptHealthOpsEvent(db, makeEvent({ eventId: "evt-1-post-crash-replay" }), {
      expectedToken: EXPECTED_TOKEN,
    });

    expect(replay.created).toBe(false); // the receipt already existed
    expect(replay.runId).toBeTruthy();

    const relinked = db.getEventReceipt(replay.receiptId)!;
    expect(relinked.status).toBe("run_created");
    expect(relinked.run_id).toBe(replay.runId);
  });

  // ── Authority boundary ────────────────────────────────────────────────────

  it("uses a fixed synthetic chat key and authority scope regardless of payload content", () => {
    const result = acceptHealthOpsEvent(
      db,
      makeEvent({ report: redReport({ pluginName: "github" }) }), // payload cannot spoof a different source/scope
      { expectedToken: EXPECTED_TOKEN },
    );
    const run = db.getRun(result.runId);
    expect(run.chat_id).toBe(HEALTH_RUN_CHAT_KEY);
    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.authority_scope).toBe("health:report-only");
  });

  // ── Bounded / redacted payload ─────────────────────────────────────────────

  it("redacts credential- or secret-shaped fields from the persisted payload", () => {
    const result = acceptHealthOpsEvent(
      db,
      makeEvent({
        report: redReport({
          summary: "Bearer summary-secret token=summary-token https://user:pass@example.test/health",
          checks: [{ name: "queue-depth", status: "red", message: "token=message-token and Bearer message-secret" }],
        }),
      }),
      { expectedToken: EXPECTED_TOKEN },
    );
    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.payload_json).not.toMatch(/summary-secret|summary-token|message-token|message-secret|user:pass/);
    expect(receipt.payload_json).toContain("[redacted]");
  });

  it("rejects a payload that exceeds the bounded size limit", () => {
    const hugeMessage = "x".repeat(20_000);
    expect(() =>
      acceptHealthOpsEvent(
        db,
        makeEvent({ report: redReport({ checks: [{ name: "queue-depth", status: "red", message: hugeMessage }] }) }),
        { expectedToken: EXPECTED_TOKEN },
      ),
    ).toThrow(OversizedEventPayloadError);
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  it("does not persist prompt content — only structured plugin/status/summary/check fields", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const receipt = db.getEventReceipt(result.receiptId)!;
    const parsed = JSON.parse(receipt.payload_json);
    expect(Object.keys(parsed).sort()).toEqual(["checks", "pluginName", "status", "summary"]);
  });
});

// ── executeHealthOpsRun: reuses the surface-neutral provider-turn owner ───────
//
// Per the independent architecture review on PR #356 ("do not replace a
// orchestration with a second provider-execution stack"), the event path
// must reach the SAME provider-turn execution owner ordinary Telegram-driven
// turns use, not a parallel reimplementation of buildCliInvocation/runCli.
// These tests construct a real BridgeEngine (the established test pattern
// used throughout test/*.test.ts, e.g. test/durableContinuationLifecycle.test.ts)
// with a fake Telegram client and an injected runCliAsync, so a spy on
// engine.executePromptAsync proves executeHealthOpsRun literally calls it,
// and the fake client proves no Telegram delivery happens along the way.

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeStreamJsonOutput(text: string, sessionId: string | null): string {
  return JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId });
}

function claudeBackgroundOutput(text: string, sessionId: string): string {
  return [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test", run_in_background: true } }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: text, session_id: sessionId }),
  ].join("\n");
}

function makeEngine(
  runCliAsync: (...args: any[]) => Promise<{ text: string }>,
  db: ReturnType<typeof openDb>,
  continuation: ConstructorParameters<typeof BridgeEngine>[4] = {},
) {
  const client = makeMockClient();
  const engine = new BridgeEngine(
    {
      surfaceIdentity: HEALTH_RUN_SURFACE,
      kind: "health",
      executionKind: "claude",
      botConfig: { command: "claude", modelPreference: ["default-model"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      asyncEnabled: true,
      pollIntervalMs: 1000,
    },
    db,
    client,
    { runCliAsync },
    continuation,
  );
  return { engine, client };
}

describe("executeHealthOpsRun", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("replays a receipt that survived before Run linking, then executes it only once", async () => {
    const originalInsertRun = db.insertRun.bind(db);
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = (() => {
      throw new Error("simulated crash before Run linking");
    }) as typeof db.insertRun;

    expect(() => acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN })).toThrow("simulated crash");
    (db as unknown as { insertRun: typeof db.insertRun }).insertRun = originalInsertRun;

    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("recovered", null) });
    const { engine } = makeEngine(runCliAsync, db);
    await resumeDurablePendingHealthEvents(db, engine, { bot: "claude" });
    await resumeDurablePendingHealthEvents(db, engine, { bot: "claude" });

    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts").get()).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get()).toEqual({ count: 1 });
    const receipt = db.raw.prepare("SELECT status, run_id FROM event_receipts").get() as { status: string; run_id: string };
    expect(receipt.status).toBe("completed");
    expect(db.getRun(receipt.run_id).status).toBe("done");
  });

  it("calls the surface-neutral provider-turn owner used by ordinary turns", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("investigated", null) });
    const { engine } = makeEngine(runCliAsync, db);
    const spy = vi.spyOn(engine, "executeSurfaceNeutralTurn");

    await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reaches the normal main-agent CLI execution path with a bounded instruction referencing the event", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    let capturedPrompt = "";
    const runCliAsync = vi.fn(async (_command: string, args: string[]) => {
      capturedPrompt = args.join(" ");
      return { text: claudeStreamJsonOutput("investigated", null) };
    });
    const { engine } = makeEngine(runCliAsync, db);

    const outcome = await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(outcome.status).toBe("done");
    expect(capturedPrompt).toContain("content-crawler");
    expect(capturedPrompt).toContain("queue backed up");
    expect(db.getRun(accepted.runId).status).toBe("done");
  });

  it("derives the execution prompt from the durable receipt and keeps continuation ownership in the engine", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent({
      report: redReport({ summary: "accepted summary", checks: [{ name: "accepted-check", status: "red", message: "accepted message" }] }),
    }), { expectedToken: EXPECTED_TOKEN });
    let callCount = 0;
    let heartbeatCount = 0;
    const originalHeartbeat = db.heartbeatLock.bind(db);
    (db as unknown as { heartbeatLock: typeof db.heartbeatLock }).heartbeatLock = ((handle) => {
      heartbeatCount += 1;
      return originalHeartbeat(handle);
    }) as typeof db.heartbeatLock;
    const runCliAsync = vi.fn(async (_command: string, args: string[], _cwd: string, options: any) => {
      callCount += 1;
      const prompt = options.stdin ? JSON.parse(String(options.stdin)).message.content : args.join(" ");
      if (callCount === 1) expect(prompt).toContain("accepted summary");
      expect(prompt).not.toContain("untrusted replacement");
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { text: callCount === 1 ? claudeBackgroundOutput("started background work", "sess-1") : claudeStreamJsonOutput("finished", "sess-1") };
    });
    const { engine } = makeEngine(runCliAsync, db, {
      hasLiveRunOwnedDescendants: vi.fn().mockReturnValueOnce(true).mockReturnValue(false),
      getRunOwnedProcessState: vi.fn().mockReturnValueOnce("live").mockReturnValue("absent"),
      killRunOwnedDescendants: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => Date.now(),
    });

    const outcome = await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(outcome.status).toBe("done");
    expect(runCliAsync).toHaveBeenCalledTimes(2);
    expect(heartbeatCount).toBeGreaterThan(0);
  });

  it("never delivers to Telegram and never persists conversation/session state merely because a health event ran", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("investigated", "sess-1") });
    const { engine, client } = makeEngine(runCliAsync, db);

    await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.sendChatAction).not.toHaveBeenCalled();
    expect(db.getSession(HEALTH_RUN_CHAT_KEY, "claude")).toBeNull();
  });

  it("executes successfully with no Worker persistence in the schema", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("ok", null) });
    const { engine } = makeEngine(runCliAsync, db);

    await executeHealthOpsRun(db, accepted.receiptId, engine);

    for (const table of ["work_items", "work_jobs"]) {
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
  });

  // ── Cancellation / fence loss ─────────────────────────────────────────────

  it("cancelling the linked Run before execution finishes prevents a late result from overwriting cancellation", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    let resolveCli!: (v: { text: string }) => void;
    const cliPromise = new Promise<{ text: string }>((resolve) => { resolveCli = resolve; });
    const runCliAsync = vi.fn().mockReturnValue(cliPromise);
    const { engine } = makeEngine(runCliAsync, db);

    const execPromise = executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(db.updateRunCancelled(accepted.runId, "operator cancelled")).toBe(true);
    resolveCli({ text: claudeStreamJsonOutput("late result", null) });

    const outcome = await execPromise;
    expect(outcome.status).toBe("failed");
    expect(db.getRun(accepted.runId).status).toBe("cancelled");
  });

  it("does not re-invoke the provider when a lane waiter resolves to a Run that already terminalized (startup replay racing live dispatch)", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("investigated", null) });
    const { engine } = makeEngine(runCliAsync, db);

    // Live dispatch completes the Run first.
    const first = await executeHealthOpsRun(db, accepted.receiptId, engine);
    expect(first.status).toBe("done");

    // A lane waiter (e.g. startup replay that queued behind the live
    // dispatch's lock) now obtains the lane for the same already-linked
    // receipt/Run and must not invoke the provider a second time.
    const second = await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("done");
    expect(db.getRun(accepted.runId).status).toBe("done");
  });

  it("invokes the provider zero times when the Run is cancelled while a caller was waiting for the health lane", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("investigated", null) });
    const { engine } = makeEngine(runCliAsync, db);

    // Simulate another owner holding the lane while this Run gets cancelled,
    // then releasing it — reproducing the window where a waiter obtains the
    // lane only after cancellation already landed.
    const holder = db.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(holder).not.toBeNull();
    expect(db.updateRunCancelled(accepted.runId, "operator cancelled while waiting")).toBe(true);
    db.unlock(holder!);

    const outcome = await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(db.getRun(accepted.runId).status).toBe("cancelled");
  });

  it("invokes the provider zero times when the durable provider-start marker already exists for a still-running Run", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("investigated", null) });
    const { engine } = makeEngine(runCliAsync, db);

    // A prior attempt for this same receipt/Run reached the provider
    // boundary (wrote the marker) and crashed before its `finally` cleared
    // it — the Run itself is still 'running' because that crash never
    // reached a terminal Run write either. A live or replayed dispatch that
    // now obtains the lane must not treat 'running' alone as proof it is
    // safe to invoke the provider.
    db.setSetting(healthEventExecutionStartedKey(accepted.receiptId), accepted.runId);

    const outcome = await executeHealthOpsRun(db, accepted.receiptId, engine);

    expect(runCliAsync).not.toHaveBeenCalled();
    expect(outcome.status).toBe("failed");
    expect(db.getRun(accepted.runId).status).toBe("running");
  });

  it("never releases or misattributes a different run's live health-lane lock when reconciling an unrelated crashed run's absence, and that run still executes exactly once", async () => {
    // Run A: an earlier receipt crashed right after reaching the provider
    // boundary, durably recording its own lane identity alongside the
    // marker (as production now does).
    const acceptedA = acceptHealthOpsEvent(db, makeEvent({
      eventId: "evt-misattribution-a", idempotencyKey: "health:misattribution-a",
    }), { expectedToken: EXPECTED_TOKEN });
    const laneHandleA = db.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(laneHandleA).not.toBeNull();
    db.setSetting(healthEventExecutionStartedKey(acceptedA.receiptId), serializeHealthEventExecutionStartedMarker({
      runId: acceptedA.runId,
      lane: { serviceId: laneHandleA!.serviceId, runId: laneHandleA!.runId, acquisitionId: laneHandleA!.acquisitionId },
    }));
    // The lane becomes free again (however that happens — natural lease
    // expiry after the crash, in production) before Run B legitimately
    // acquires it.
    db.unlock(laneHandleA!);

    // Run B: a second, unrelated receipt legitimately acquires the SAME
    // lane afterward and starts real provider work.
    const acceptedB = acceptHealthOpsEvent(db, makeEvent({
      eventId: "evt-misattribution-b", idempotencyKey: "health:misattribution-b",
    }), { expectedToken: EXPECTED_TOKEN });
    let resolveCli!: (v: { text: string }) => void;
    const cliPromise = new Promise<{ text: string }>((resolve) => { resolveCli = resolve; });
    const runCliAsync = vi.fn().mockReturnValue(cliPromise);
    const { engine } = makeEngine(runCliAsync, db);

    const execPromiseB = executeHealthOpsRun(db, acceptedB.receiptId, engine);
    // executeHealthOpsRun acquires its lane synchronously before its first
    // await, so by now B genuinely holds the lane with a fresh, unexpired
    // lease distinct from A's old (already-released) identity.
    const lockBefore = db.raw.prepare(
      `SELECT service_id, run_id, acquisition_id FROM execution_locks WHERE surface = ? AND chat_key = ?`
    ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(lockBefore).toBeDefined();

    const scheduleRetry = vi.fn();
    await reconcileAbandonedHealthLeases(db, { processState: () => "absent", scheduleRetry });

    // B's lock must survive completely untouched — it does not belong to
    // the crashed generation, no matter how confidently A's process is
    // proven absent.
    const lockAfter = db.raw.prepare(
      `SELECT service_id, run_id, acquisition_id FROM execution_locks WHERE surface = ? AND chat_key = ?`
    ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(lockAfter).toEqual(lockBefore);
    expect(db.getRun(acceptedA.runId).status).toBe("running");
    // Ownership no longer correlates to anything this pass captured for A,
    // so scheduling a retry against it would only ever misattribute again.
    expect(scheduleRetry).not.toHaveBeenCalled();

    resolveCli({ text: claudeStreamJsonOutput("investigated", null) });
    const outcomeB = await execPromiseB;
    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(outcomeB.status).toBe("done");

    // Now that B has finished and released the lane, the next
    // reconciliation opportunity safely terminalizes A — B is unaffected,
    // having already run to completion.
    await reconcileAbandonedHealthLeases(db, { processState: () => "absent" });
    expect(db.getRun(acceptedA.runId).status).toBe("failed");
    expect(db.getRun(acceptedB.runId).status).toBe("done");
  });

  it("rejects with HealthOpsRunLaneUnavailableError when the health execution lane is already held", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("ok", null) });
    const { engine } = makeEngine(runCliAsync, db);

    const handle = db.acquireLock(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY);
    expect(handle).not.toBeNull();

    await expect(executeHealthOpsRun(db, accepted.receiptId, engine)).rejects.toBeInstanceOf(
      HealthOpsRunLaneUnavailableError,
    );
    expect(runCliAsync).not.toHaveBeenCalled();
  });

  it("recovers a surface-neutral continuation on a health engine after restart", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const repo = new ContinuationRepository(db.raw);
    repo.saveWaiting({
      runId: accepted.runId,
      surface: HEALTH_RUN_SURFACE,
      chatKey: HEALTH_RUN_CHAT_KEY,
      chatId: 0,
      threadId: null,
      bot: "claude",
      sessionId: "session-1",
      executionMode: "async",
      triggerKind: "run-owned-background-process",
      triggerId: accepted.runId,
      resumptionCount: 0,
      pendingIds: [],
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      deliveryState: "none",
    });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("recovered", "session-2") });
    const { engine } = makeEngine(runCliAsync, db, { getRunOwnedProcessState: () => "absent" });

    await engine.recoverContinuations();
    for (let i = 0; i < 50 && db.getRun(accepted.runId)?.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runCliAsync).toHaveBeenCalled();
    expect(db.getRun(accepted.runId)?.status).toBe("done");
  });

  // ── Result correlation ────────────────────────────────────────────────────

  it("reconcileEventReceiptResult correlates a completed Run's result back onto the receipt", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeStreamJsonOutput("ok", null) });
    const { engine } = makeEngine(runCliAsync, db);
    await executeHealthOpsRun(db, accepted.receiptId, engine);

    reconcileEventReceiptResult(db, accepted.receiptId);

    const receipt = db.getEventReceipt(accepted.receiptId)!;
    expect(receipt.status).toBe("completed");
    expect(receipt.result_reference).toBe(`run:${accepted.runId}`);
    expect(receipt.error_class).toBeNull();
  });

  it("reconcileEventReceiptResult correlates a failed Run's error class back onto the receipt", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const runCliAsync = vi.fn().mockRejectedValue(new Error("cli exploded"));
    const { engine } = makeEngine(runCliAsync, db);
    await executeHealthOpsRun(db, accepted.receiptId, engine);

    reconcileEventReceiptResult(db, accepted.receiptId);

    const receipt = db.getEventReceipt(accepted.receiptId)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.error_class).toBe("run_failed");
  });

  it("reconcileEventReceiptResult correlates a cancelled Run onto the receipt", () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    db.updateRunCancelled(accepted.runId, "operator cancelled");

    reconcileEventReceiptResult(db, accepted.receiptId);

    const receipt = db.getEventReceipt(accepted.receiptId)!;
    expect(receipt.status).toBe("cancelled");
    expect(receipt.error_class).toBe("run_cancelled");
  });

  it("reconcileEventReceiptResult is a no-op while the Run is still in flight", () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    reconcileEventReceiptResult(db, accepted.receiptId);
    const receipt = db.getEventReceipt(accepted.receiptId)!;
    expect(receipt.status).toBe("run_created");
  });

  it("HEALTH_RUN_SURFACE/HEALTH_RUN_CHAT_KEY name a stable, non-Telegram-shaped lane", () => {
    expect(HEALTH_RUN_SURFACE).toBe("health");
    expect(HEALTH_RUN_CHAT_KEY).toBe("health:ops");
  });
});
