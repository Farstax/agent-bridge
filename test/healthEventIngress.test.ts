import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  acceptHealthOpsEvent,
  executeHealthOpsRun,
  reconcileEventReceiptResult,
  UnauthenticatedEventError,
  OversizedEventPayloadError,
  HEALTH_RUN_SURFACE,
  HEALTH_RUN_CHAT_KEY,
  type HealthOpsEventInput,
} from "../src/health/eventIngress.js";
import type { HealthReport } from "../src/health/types.js";

/**
 * Issue #351 (corrected architecture, see issue body + PR #356 review
 * comments): external health event -> authenticated/idempotent durable
 * receipt -> ordinary owning Run (bridge_runs) -> main agent CLI turn ->
 * terminal Run/result -> receipt correlation. No work_item/work_job/
 * ops_check handler is involved anywhere in this path.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  const dbPath = join(tmpdir(), `health-event-ingress-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-service", runId: "test-process" });
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
    ({ db, dbPath } = makeDb());
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
    expect(db.listRunningRuns?.() ?? []).toHaveLength(0);
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

  it("never routes through work_items or work_jobs", () => {
    acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    expect(db.listWorkItems()).toHaveLength(0);
    expect(db.listWorkJobs()).toHaveLength(0);
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
          checks: [{ name: "queue-depth", status: "red", message: "queue backed up", value: "secret_api_key=abcdef" } as any],
        }),
      }),
      { expectedToken: EXPECTED_TOKEN },
    );
    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.payload_json).not.toContain("abcdef");
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
    expect(db.listRunningRuns()).toHaveLength(0);
  });

  it("does not persist prompt content — only structured plugin/status/summary/check fields", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const receipt = db.getEventReceipt(result.receiptId)!;
    const parsed = JSON.parse(receipt.payload_json);
    expect(Object.keys(parsed).sort()).toEqual(["checks", "pluginName", "status", "summary"]);
  });
});

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

  it("reaches the normal main-agent CLI execution path with a bounded instruction referencing the event", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    let capturedPrompt = "";
    const fakeRunCli = async (_command: string, args: string[]) => {
      capturedPrompt = args.join(" ");
      return JSON.stringify({ result: "investigated", session_id: null });
    };

    const outcome = await executeHealthOpsRun(db, accepted.receiptId, makeEvent(), { runCli: fakeRunCli });

    expect(outcome.status).toBe("done");
    expect(capturedPrompt).toContain("content-crawler");
    expect(capturedPrompt).toContain("queue backed up");
    expect(db.getRun(accepted.runId).status).toBe("done");
  });

  it("never touches work_items/work_jobs during execution", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const fakeRunCli = async () => JSON.stringify({ result: "ok" });

    await executeHealthOpsRun(db, accepted.receiptId, makeEvent(), { runCli: fakeRunCli });

    expect(db.listWorkItems()).toHaveLength(0);
    expect(db.listWorkJobs()).toHaveLength(0);
  });

  // ── Cancellation / fence loss ─────────────────────────────────────────────

  it("cancelling the linked Run before execution finishes prevents a late result from overwriting cancellation", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    let resolveCli!: (v: string) => void;
    const cliPromise = new Promise<string>((resolve) => { resolveCli = resolve; });
    const fakeRunCli = async () => cliPromise;

    const execPromise = executeHealthOpsRun(db, accepted.receiptId, makeEvent(), { runCli: fakeRunCli });

    expect(db.updateRunCancelled(accepted.runId, "operator cancelled")).toBe(true);
    resolveCli(JSON.stringify({ result: "late result" }));

    const outcome = await execPromise;
    expect(outcome.status).toBe("failed");
    expect(db.getRun(accepted.runId).status).toBe("cancelled");
  });

  // ── Result correlation ────────────────────────────────────────────────────

  it("reconcileEventReceiptResult correlates a completed Run's result back onto the receipt", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const fakeRunCli = async () => JSON.stringify({ result: "ok" });
    await executeHealthOpsRun(db, accepted.receiptId, makeEvent(), { runCli: fakeRunCli });

    reconcileEventReceiptResult(db, accepted.receiptId);

    const receipt = db.getEventReceipt(accepted.receiptId)!;
    expect(receipt.status).toBe("completed");
    expect(receipt.result_reference).toBe(`run:${accepted.runId}`);
    expect(receipt.error_class).toBeNull();
  });

  it("reconcileEventReceiptResult correlates a failed Run's error class back onto the receipt", async () => {
    const accepted = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const fakeRunCli = async () => { throw new Error("cli exploded"); };
    await executeHealthOpsRun(db, accepted.receiptId, makeEvent(), { runCli: fakeRunCli });

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
