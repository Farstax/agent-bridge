import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/rollout-acceptance.py";

function evidence(path = "/tmp/bridge.sqlite", overrides: Record<string, unknown> = {}): object {
  return {
    mode: "validate",
    databases: [{
      path,
      integrity: "ok",
      schema: "current",
      schemaVersion: 3,
      foreignKeyViolations: 0,
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
  it("accepts healthy databases despite run, queue and lock changes", () => {
    const before = evidence("/tmp/bridge.sqlite", {
      runningRunCount: 3,
      claimedMessageCount: 1,
      executionLockCount: 1,
    });
    const after = evidence("/tmp/bridge.sqlite", {
      runningRunCount: 0,
      claimedMessageCount: 0,
      executionLockCount: 0,
    });
    expect(run(before, after, { databases: [] })).toContain("accepted");
  });

  it("rejects a database inventory change", () => {
    expect(() => run(evidence("/tmp/a.sqlite"), evidence("/tmp/b.sqlite"))).toThrow(/inventory/i);
  });

  it("rejects post-start integrity failure", () => {
    expect(() => run(evidence(), evidence("/tmp/bridge.sqlite", { integrity: "corrupt" }))).toThrow(/integrity/i);
  });

  it("rejects a non-current post-start schema", () => {
    expect(() => run(evidence(), evidence("/tmp/bridge.sqlite", { schema: "legacy" }))).toThrow(/schema/i);
  });
});
