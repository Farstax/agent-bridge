import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { actions, createFixture, prepareImmutableRelease, rewriteConfig, runRollout } from "./support/rolloutFixture.js";

describe("guarded rollout ACP telemetry retention", { timeout: 30_000 }, () => {

  it("preserves the retired health schema allowance through telemetry pruning", () => {
    const fixture = createFixture();
    prepareImmutableRelease(fixture, fixture.previousCommit);
    const runtimeUser = process.env.USER ?? "root";
    rewriteConfig(fixture, (lines) => lines.map((line) =>
      line.startsWith("runtime_user=") ? `runtime_user=${runtimeUser}` : line
    ));

    const healthDb = new Database(fixture.dbPaths[2]);
    healthDb.exec("CREATE TABLE health_plugin_reports(id INTEGER PRIMARY KEY, payload TEXT)");
    healthDb.close();

    const result = runRollout(fixture);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const pruneCalls = actions(fixture).split("\n")
      .filter((line) => line.startsWith("runuser:") && line.includes(" prune "));
    expect(pruneCalls).toHaveLength(1);
    expect(pruneCalls[0]).toContain("--allow-retired-health");
  }, 20_000);
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
