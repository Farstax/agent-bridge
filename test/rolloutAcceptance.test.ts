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

  it("accepts the production cohort with running rows and locks in preflight evidence", () => {
    expect(run(evidence({
      executionLockState: { total: 1, active: 1 },
      deliveryState: { running: 6 },
    }), evidence({
      executionLockState: { total: 0, active: 0 },
      deliveryState: { failed: 6 },
    }))).toContain("accepted");
  });

  it("rejects an unhealthy or non-current post-start database", () => {
    expect(() => run(evidence(), evidence({ integrity: "corrupt" }))).toThrow(/integrity/i);
    expect(() => run(evidence(), evidence({ schema: "migratable" }))).toThrow(/schema/i);
  });
});
