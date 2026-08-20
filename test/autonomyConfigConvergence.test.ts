import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupRoots,
  createFixture,
  runRollout,
} from "./support/rolloutFixture";

afterEach(cleanupRoots);

const DEPLOYER_ENV = {
  AGENT_BRIDGE_DEPLOYER_MODE: "1",
  AGENT_BRIDGE_DEPLOY_ARTIFACT_SHA256: "a".repeat(64),
  AGENT_BRIDGE_DEPLOY_ENVIRONMENT: "production-content-crawler",
  AGENT_BRIDGE_DEPLOY_APPROVAL_REFERENCE: "issue-498-test",
};

describe("autonomy database production config convergence (#498)", () => {
  it("converges a legacy deployer-managed rollout config before strict inventory validation", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "company-autonomy", "bridge.sqlite");
    const autonomyParent = join(fixture.root, "company-autonomy");
    writeFileSync(
      join(fixture.envDir, "agent-bridge-interactive"),
      `DB_PATH=${fixture.dbPaths[3]}\nAGENT_BRIDGE_AUTONOMY_DB_PATH=${autonomyPath}\n`,
      { mode: 0o600 },
    );
    expect(existsSync(autonomyParent)).toBe(false);
    expect(readFileSync(fixture.configFile, "utf8")).not.toContain(`database=${autonomyPath}`);

    const result = runRollout(fixture, undefined, undefined, DEPLOYER_ENV);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(autonomyPath)).toBe(true);
    expect(existsSync(autonomyParent)).toBe(true);
    const config = readFileSync(fixture.configFile, "utf8");
    expect(config.match(new RegExp(`^database=${autonomyPath.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "gm"))?.length).toBe(1);
  }, 20_000);

  it("keeps ordinary manually-authorized rollout fail-closed when the fixed allowlist was not converged", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "company-autonomy", "bridge.sqlite");
    writeFileSync(
      join(fixture.envDir, "agent-bridge-interactive"),
      `DB_PATH=${fixture.dbPaths[3]}\nAGENT_BRIDGE_AUTONOMY_DB_PATH=${autonomyPath}\n`,
      { mode: 0o600 },
    );

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/database inventory counts differ|discovered database missing from root allowlist/i);
    expect(existsSync(autonomyPath)).toBe(false);
  });

  it("fresh-install inventory validates and bootstraps the configured autonomy database as interactive", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-autonomy-install-"));
    try {
      const release = join(root, "release");
      const stateRoot = join(root, "state");
      mkdirSync(join(release, "node_modules", "tsx", "dist"), { recursive: true });
      mkdirSync(join(release, "scripts"), { recursive: true });
      writeFileSync(join(release, "node_modules", "tsx", "dist", "cli.mjs"), "// fixture\n");
      writeFileSync(join(release, "scripts", "rollout-db.ts"), "// fixture\n");
      const installer = resolve("scripts/agent-bridge-install.py");
      const probe = String.raw`
import importlib.util, json
from pathlib import Path
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("installer", ${JSON.stringify(installer)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
state_root = Path(${JSON.stringify(stateRoot)})
interactive = next(service for service in module.SERVICES if service[0] == "agent-bridge-interactive.service")
autonomy = state_root / "company-autonomy" / "bridge.sqlite"
resolved = module.configured_autonomy_database(
    {"AGENT_BRIDGE_AUTONOMY_DB_PATH": str(autonomy)}, state_root, [interactive]
)
calls = []
module.subprocess.run = lambda args, **kwargs: calls.append(args) or SimpleNamespace(returncode=0, stdout="", stderr="")
primary = module.database_path(state_root, interactive)
module.bootstrap_databases(
    Path(${JSON.stringify(release)}), Path("/usr/bin/node"), SimpleNamespace(pw_name="agentbridge"),
    [interactive], [primary, autonomy],
)
print(json.dumps({"resolved": str(resolved), "calls": calls}))
`;
      const output = execFileSync("python3", ["-c", probe], { encoding: "utf8" });
      const evidence = JSON.parse(output);
      expect(evidence.resolved).toBe(join(stateRoot, "company-autonomy", "bridge.sqlite"));
      expect(evidence.calls).toHaveLength(2);
      expect(evidence.calls[1]).toContain("interactive");
      expect(evidence.calls[1]).toContain(join(stateRoot, "company-autonomy", "bridge.sqlite"));

      const source = readFileSync("scripts/agent-bridge-install.py", "utf8");
      expect(source).toContain("databases.append(autonomy_database)");
      expect(source).toContain("require_fresh_database_targets(state_root, selected, os.environ)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
