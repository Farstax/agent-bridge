import { describe, expect, it } from "vitest";
import { actions, createFixture, prepareImmutableRelease, runRollout } from "./support/rolloutFixture.js";

describe("guarded rollout ACP telemetry retention", () => {
  it("runs retention only after the verified database backup", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);

    const result = runRollout(fixture);
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const log = actions(fixture);
    const firstBackup = log.indexOf("root: backup ");
    const prune = log.indexOf(" prune ");
    expect(firstBackup).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(firstBackup);
    expect(result.stdout).toContain("pruning expired ACP telemetry from terminal runs");
  });
});
