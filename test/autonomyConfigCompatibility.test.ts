import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRoots,
  createFixture,
  rewriteConfig,
  runRollout,
} from "./support/rolloutFixture";

const DEPLOYER_ENV = {
  AGENT_BRIDGE_DEPLOYER_MODE: "1",
  AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256: "b".repeat(64),
  AGENT_BRIDGE_DEPLOY_ENVIRONMENT: "production-content-crawler",
  AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE: "issue-498-compatibility-test",
};

afterEach(cleanupRoots);

describe("autonomy rollout config convergence compatibility (#498)", () => {
  it("does not impose migration-only sibling placement on an already configured safe autonomy database", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "external-state", "nested", "autonomy.sqlite");
    mkdirSync(dirname(autonomyPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(fixture.envDir, "agent-bridge-interactive"),
      `DB_PATH=${fixture.dbPaths[3]}\nAGENT_BRIDGE_AUTONOMY_DB_PATH=${autonomyPath}\n`,
      { mode: 0o600 },
    );
    rewriteConfig(fixture, (lines) => [...lines, `database=${autonomyPath}`]);

    const result = runRollout(fixture, undefined, undefined, DEPLOYER_ENV);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 20_000);
});
