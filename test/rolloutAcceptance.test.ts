import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/rollout-acceptance.py";

function evidence(overrides: Record<string, unknown> = {}): object {
  return {
    mode: "validate",
    databases: [{
      path: "/tmp/bridge.sqlite",
      integrity: "ok",
      schema: "current",
      schemaVersion: 3,
      pendingQueueCount: 1,
      legacyQueueCount: 0,
      queueStateCounts: { claimed: 1 },
      claimStateCounts: { claimed: 1 },
      executionLockState: { total: 0, active: 0 },
      claimRunAcquisitionCorrelation: "same-claim",
      runLockCorrelation: { queue: [{ id: 1, state: "claimed", claim_run_id: "run-1", claim_acquisition_id: "acq-1" }], locks: [] },
      deliveryState: { running: 1 },
      runIdentityCorrelation: [{ run_id: "run-1", status: "running", started_at: "2026-07-26T12:00:00Z" }],
      deliveryIdentityCorrelation: [{ id: "run-1:1", run_id: "run-1", seq: 1, type: "run.started" }],
      ...overrides,
    }],
  };
}

function run(before: object, after: object, reconciliation?: object): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-acceptance-"));
  const beforePath = join(root, "before.json");
  const afterPath = join(root, "after.json");
  const outputPath = join(root, "acceptance.json");
  writeFileSync(beforePath, JSON.stringify(before));
  writeFileSync(afterPath, JSON.stringify(after));
  const args = [SCRIPT, "--before", beforePath, "--after", afterPath, "--output", outputPath];
  if (reconciliation) {
    const reconciliationPath = join(root, "reconciliation.json");
    writeFileSync(reconciliationPath, JSON.stringify(reconciliation));
    args.push("--reconciliation-evidence", reconciliationPath);
  }
  return execFileSync("python3", args, { encoding: "utf8" });
}

describe("rollout acceptance evidence", () => {
  it("accepts unchanged pending/claimed queue and lock correlation", () => {
    expect(run(evidence(), evidence())).toContain("accepted");
  });

  it("rejects an unexpected active execution lock", () => {
    expect(() => run(evidence(), evidence({ executionLockState: { total: 1, active: 1 } }))).toThrow(/active execution lock/i);
  });

  it("rejects silent replay or duplicate-delivery drift", () => {
    expect(() => run(evidence(), evidence({
      runLockCorrelation: { queue: [{ id: 1, state: "claimed", claim_run_id: "run-2", claim_acquisition_id: "acq-2" }], locks: [] },
    }))).toThrow(/correlation|duplicate|replay/i);
  });

  it("rejects replacement runs and repeated delivery with unchanged counts", () => {
    expect(() => run(evidence(), evidence({
      runIdentityCorrelation: [{ run_id: "replacement-run", status: "running", started_at: "2026-07-26T12:00:00Z" }],
      deliveryIdentityCorrelation: [{ id: "replacement-run:1", run_id: "replacement-run", seq: 1, type: "run.started" }],
    }))).toThrow(/identity|delivery|replay/i);
  });

  it("accepts live-correlated preflight activity after audited containment reconciliation", () => {
    const before = evidence({
      executionLockState: { total: 1, active: 1 },
      runLockCorrelation: { queue: [], locks: [{ surface: "telegram:interactive", chat_key: "chat-1", run_id: "run-1", acquisition_id: "acq-1" }] },
      lifecycle: { runs: [{ run_id: "run-1", classification: "live-correlated" }], locks: [{ run_id: "run-1", classification: "live-correlated" }] },
    });
    const after = evidence({
      executionLockState: { total: 0, active: 0 },
      runLockCorrelation: { queue: [], locks: [] },
      runIdentityCorrelation: [{ run_id: "run-1", status: "failed", error: "interrupted_by_controlled_rollout", started_at: "2026-07-26T12:00:00Z" }],
      deliveryIdentityCorrelation: [
        { id: "run-1:1", run_id: "run-1", seq: 1, type: "run.started" },
        { id: "run-1:2", run_id: "run-1", seq: 2, type: "reconciliation.started" },
      ],
      lifecycle: { reconciliation: { runs: ["run-1"], locks: [{ run_id: "run-1", acquisition_id: "acq-1" }] } },
    });
    expect(run(before, after)).toContain("accepted");
  });

  it("accepts append-only post-restart runs and events while preserving pre-existing identities", () => {
    const after = evidence({
      deliveryState: { running: 1, done: 1 },
      runIdentityCorrelation: [
        { run_id: "run-1", status: "running", started_at: "2026-07-26T12:00:00Z" },
        { run_id: "post-restart", status: "done", started_at: "2026-07-29T12:01:00Z" },
      ],
      deliveryIdentityCorrelation: [
        { id: "run-1:1", run_id: "run-1", seq: 1, type: "run.started" },
        { id: "post-restart:1", run_id: "post-restart", seq: 1, type: "run.started" },
      ],
    });
    expect(run(evidence(), after)).toContain("accepted");
  });

  it("rejects a new run created before the recorded restart boundary", () => {
    expect(() => run(
      evidence(),
      evidence({
        restartBoundary: "2026-07-29T12:00:00.000Z",
        runIdentityCorrelation: [
          { run_id: "run-1", status: "running", started_at: "2026-07-26T12:00:00Z" },
          { run_id: "replayed", status: "done", started_at: "2026-07-29T11:59:59.000Z" },
        ],
        deliveryIdentityCorrelation: [
          { id: "run-1:1", run_id: "run-1", seq: 1, type: "run.started" },
          { id: "replayed:1", run_id: "replayed", seq: 1, type: "run.started" },
        ],
      }),
    )).toThrow(/restart boundary|pre-existing run/i);
  });

  it("uses only the current rollout reconciliation evidence", () => {
    const before = evidence({
      executionLockState: { total: 1, active: 1 },
      runLockCorrelation: { queue: [], locks: [{ surface: "telegram:interactive", chat_key: "chat-1", run_id: "run-1", acquisition_id: "acq-1" }] },
      lifecycle: { runs: [{ run_id: "run-1", classification: "live-correlated" }], locks: [{ run_id: "run-1", classification: "live-correlated" }] },
    });
    const after = evidence({
      executionLockState: { total: 0, active: 0 },
      runLockCorrelation: { queue: [], locks: [] },
      runIdentityCorrelation: [{ run_id: "run-1", status: "failed", error: "interrupted_by_controlled_rollout", started_at: "2026-07-26T12:00:00Z" }],
      deliveryIdentityCorrelation: [{ id: "run-1:1", run_id: "run-1", seq: 1, type: "run.started" }],
      lifecycle: { reconciliation: { runs: ["run-1"], locks: [{ run_id: "run-1", acquisition_id: "acq-1" }] } },
    });
    expect(() => run(before, after, evidence({ lifecycle: { reconciliation: { runs: ["old-run"], locks: [] } } }))).toThrow(/current rollout|reconciliation|status/i);
  });
});
