import { join } from "node:path";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  actions,
  cleanupRoots,
  createFixture,
  runRollout,
} from "./support/rolloutFixture";

const DEPLOYER_ENV = {
  AGENT_BRIDGE_DEPLOYER_MODE: "1",
  AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256: "c".repeat(64),
  AGENT_BRIDGE_DEPLOY_ENVIRONMENT: "production-content-crawler",
  AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE: "issue-498-safety-test",
};

afterEach(cleanupRoots);

describe("autonomy rollout config convergence safety (#498)", () => {
  it("rejects an occupied symlink target before mutating the fixed rollout config", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "databases", "autonomy.sqlite");
    symlinkSync(fixture.dbPaths[0], autonomyPath);
    writeFileSync(
      join(fixture.envDir, "agent-bridge-interactive"),
      `DB_PATH=${fixture.dbPaths[3]}\nAGENT_BRIDGE_AUTONOMY_DB_PATH=${autonomyPath}\n`,
      { mode: 0o600 },
    );
    const before = readFileSync(fixture.configFile, "utf8");

    const result = runRollout(fixture, undefined, undefined, DEPLOYER_ENV);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/autonomy database target is occupied by an unsafe path/i);
    expect(readFileSync(fixture.configFile, "utf8")).toBe(before);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });
});
