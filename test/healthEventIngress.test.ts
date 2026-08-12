import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  acceptHealthOpsEvent,
  reconcileEventReceiptResult,
  UnauthenticatedEventError,
  OversizedEventPayloadError,
  type HealthOpsEventInput,
} from "../src/health/eventIngress.js";
import { executeNextJob, PermanentJobFailureError } from "../src/jobExecutor.js";
import { createOpsCheckHandler } from "../src/handlers/opsCheck.js";
import type { HealthReport } from "../src/health/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDb() {
  const dbPath = join(tmpdir(), `health-event-ingress-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath);
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
    expect(db.listWorkItems()).toHaveLength(0);
  });

  it("rejects an event whose token does not match the configured authority", () => {
    expect(() =>
      acceptHealthOpsEvent(db, makeEvent({ token: "wrong-token" }), { expectedToken: EXPECTED_TOKEN }),
    ).toThrow(UnauthenticatedEventError);
    expect(db.listWorkItems()).toHaveLength(0);
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  it("does not persist a receipt for a rejected unauthenticated event", () => {
    try {
      acceptHealthOpsEvent(db, makeEvent(), { expectedToken: "different-secret" });
    } catch { /* expected */ }
    expect(db.getEventReceiptByIdempotencyKey(makeEvent().idempotencyKey)).toBeNull();
  });

  // ── Idempotency / duplicate delivery ─────────────────────────────────────

  it("accepts an authenticated red-status event and creates exactly one receipt, work_item, and work_job", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    expect(result.created).toBe(true);
    expect(result.workItemId).not.toBeNull();
    expect(result.workJobId).not.toBeNull();

    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("run_created");
    expect(receipt.source).toBe("health");
    expect(receipt.work_item_id).toBe(result.workItemId);
    expect(receipt.work_job_id).toBe(result.workJobId);

    const job = db.getWorkJob(result.workJobId!)!;
    expect(job.task_type).toBe("ops_check");
    expect(job.status).toBe("pending");
  });

  it("duplicate delivery of the same idempotency key creates one receipt and one writable Run, not two", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const second = acceptHealthOpsEvent(db, makeEvent({ eventId: "evt-1-retry" }), { expectedToken: EXPECTED_TOKEN });

    expect(second.created).toBe(false);
    expect(second.receiptId).toBe(first.receiptId);
    expect(second.workItemId).toBe(first.workItemId);
    expect(second.workJobId).toBe(first.workJobId);

    expect(db.listWorkItems()).toHaveLength(1);
    expect(db.listWorkJobs()).toHaveLength(1);
  });

  it("a different idempotency key for the same plugin creates a second independent receipt and Run", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const second = acceptHealthOpsEvent(
      db,
      makeEvent({ idempotencyKey: "health:content-crawler:red:2026-08-12T01:00:00Z" }),
      { expectedToken: EXPECTED_TOKEN },
    );

    expect(second.receiptId).not.toBe(first.receiptId);
    expect(second.workJobId).not.toBe(first.workJobId);
    expect(db.listWorkItems()).toHaveLength(2);
  });

  // ── Restart-safe replay ───────────────────────────────────────────────────

  it("replaying acceptance after a simulated restart does not duplicate the Run", () => {
    const first = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    // Simulate a process restart by reopening a fresh ingress call against
    // the same durable db state with the same idempotency key.
    const replay = acceptHealthOpsEvent(db, makeEvent({ eventId: "evt-1-replay" }), { expectedToken: EXPECTED_TOKEN });

    expect(replay.workJobId).toBe(first.workJobId);
    expect(db.listWorkJobs()).toHaveLength(1);
  });

  it("the created work_job is claimable and completes through the standard restart-safe lease path", async () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    const outcome = await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { ops_check: createOpsCheckHandler() },
      notify: async () => {},
    });

    expect(outcome?.jobId).toBe(result.workJobId);
    expect(db.getWorkJob(result.workJobId!)!.status).toBe("completed");
  });

  // ── Cancellation / fence loss ─────────────────────────────────────────────

  it("cancelling the linked Run before execution prevents the job from completing, and completion never overwrites cancellation", async () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    // A worker claims the lease first (as it would mid-execution)...
    const claimed = db.claimNextWorkJob("test-worker", new Date().toISOString(), 300);
    expect(claimed?.id).toBe(result.workJobId);

    // ...then the run is cancelled out from under it (fence loss).
    db.cancelWorkJob(result.workJobId!, "operator cancelled");
    expect(db.getWorkJob(result.workJobId!)!.status).toBe("cancelled");

    // The original lease owner's late completion must not overwrite cancellation.
    db.completeWorkJob(result.workJobId!, { summary: "should not apply" }, "test-worker");
    expect(db.getWorkJob(result.workJobId!)!.status).toBe("cancelled");

    // Nor is the job claimable again by anyone.
    expect(db.claimNextWorkJob("rival-worker", new Date().toISOString(), 300)).toBeNull();
  });

  it("reconcileEventReceiptResult reflects a cancelled Run onto the receipt without re-creating work", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    db.cancelWorkJob(result.workJobId!, "operator cancelled");

    reconcileEventReceiptResult(db, result.receiptId);

    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("cancelled");
    expect(receipt.error_class).toBe("run_cancelled");
    expect(db.listWorkJobs()).toHaveLength(1);
  });

  // ── Result correlation ────────────────────────────────────────────────────

  it("reconcileEventReceiptResult correlates a completed Run's result back onto the receipt", async () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: { ops_check: createOpsCheckHandler() },
      notify: async () => {},
    });

    reconcileEventReceiptResult(db, result.receiptId);

    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("completed");
    expect(receipt.result_reference).toBe(`work_job:${result.workJobId}`);
    expect(receipt.error_class).toBeNull();
  });

  it("reconcileEventReceiptResult correlates a failed Run's error class back onto the receipt", async () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });

    await executeNextJob({
      db,
      workerId: "test-worker",
      handlers: {
        ops_check: async () => { throw new PermanentJobFailureError("diagnostic failed"); },
      },
      notify: async () => {},
    });
    expect(db.getWorkJob(result.workJobId!)!.status).toBe("failed");

    reconcileEventReceiptResult(db, result.receiptId);

    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.error_class).toBe("run_failed");
  });

  it("reconcileEventReceiptResult is a no-op while the Run is still in flight", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    reconcileEventReceiptResult(db, result.receiptId);
    const receipt = db.getEventReceipt(result.receiptId)!;
    expect(receipt.status).toBe("run_created");
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
    expect(db.listWorkItems()).toHaveLength(0);
  });

  it("does not persist prompt content — only structured plugin/status/summary/check fields", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const receipt = db.getEventReceipt(result.receiptId)!;
    const parsed = JSON.parse(receipt.payload_json);
    expect(Object.keys(parsed).sort()).toEqual(["checks", "pluginName", "status", "summary"]);
  });

  // ── Authority boundary ────────────────────────────────────────────────────

  it("derives work_item.source from the authenticated caller, never from payload content", () => {
    const result = acceptHealthOpsEvent(
      db,
      makeEvent({ report: redReport({ pluginName: "github" }) }), // payload cannot spoof a different source
      { expectedToken: EXPECTED_TOKEN },
    );
    const item = db.getWorkItem(result.workItemId!)!;
    expect(item.source).toBe("health");
  });

  it("creates a report-only work item that requires separate approval before any mutation job is created", () => {
    const result = acceptHealthOpsEvent(db, makeEvent(), { expectedToken: EXPECTED_TOKEN });
    const item = db.getWorkItem(result.workItemId!)!;
    expect(item.status).toBe("proposed");
    expect(db.listWorkJobs().every((job) => job.task_type === "ops_check")).toBe(true);
  });
});
