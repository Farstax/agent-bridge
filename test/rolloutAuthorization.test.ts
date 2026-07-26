import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = "scripts/rollout-authorization.py";
const COMMIT = "a".repeat(40);

function writeAuthorization(overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-authorization-"));
  const path = join(root, "approval.json");
  writeFileSync(path, JSON.stringify({
    principal: "operator@example.invalid",
    reference: "issue-183-approval-1",
    approved_target_commit: COMMIT,
    approved_at: "2026-07-26T12:00:00Z",
    expires_at: "2099-07-26T12:00:00Z",
    scope: "issue-183-production-activation",
    ...overrides,
  }) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function validate(path: string, expectedCommit = COMMIT, now = "2026-07-26T13:00:00Z"): string {
  return execFileSync("python3", [SCRIPT, "--file", path, "--expected-commit", expectedCommit, "--now", now], {
    encoding: "utf8",
  });
}

describe("rollout authorization", () => {
  it("validates a complete, target-bound, unexpired approval", () => {
    expect(validate(writeAuthorization())).toContain(`"approved_target_commit": "${COMMIT}"`);
  });

  it.each([
    ["missing principal", { principal: "" }, /principal/i],
    ["mismatched target", { approved_target_commit: "b".repeat(40) }, /target commit/i],
    ["expired", { expires_at: "2026-07-26T12:59:59Z" }, /expired/i],
    ["missing reference", { reference: null }, /reference/i],
    ["missing scope", { scope: null }, /scope/i],
  ])("rejects %s", (_label, overrides, error) => {
    expect(() => validate(writeAuthorization(overrides))).toThrow(error);
  });
});
