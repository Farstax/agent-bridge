import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import {
  actions,
  cleanupRoots,
  createFixture,
  createLegacyDb,
  rewriteConfig,
  runRollout,
  type Fixture,
} from "./support/rolloutFixture";

// Issue #498: agent-bridge-interactive.service crash-loops in production
// when AGENT_BRIDGE_AUTONOMY_DB_PATH is configured but the second,
// autonomy-owned database file doesn't exist yet on a freshly provisioned
// host — openProductionDb() deliberately refuses to create a missing file
// (Phase 4C.2, issue #135), and the guarded rollout tooling never learned
// about this second DB at all. These tests prove the guarded rollout now
// provisions that database itself, through the same sanctioned
// `rollout-db.ts bootstrap` primitive every other newly-added role uses,
// strictly between containment and pointer activation, without weakening
// the existing configured/discovered database inventory bijection check.

afterEach(cleanupRoots);

function artifactDir(fixture: Fixture): string {
  return readFileSync(join(fixture.logDir, "latest"), "utf8").trim();
}

function setAutonomyEnv(fixture: Fixture, path: string): void {
  writeFileSync(join(fixture.envDir, "agent-bridge-interactive"), `DB_PATH=${fixture.dbPaths[3]}\nAGENT_BRIDGE_AUTONOMY_DB_PATH=${path}\n`, { mode: 0o600 });
}

function addAutonomyToAllowlist(fixture: Fixture, path: string): void {
  rewriteConfig(fixture, (lines) => [...lines, `database=${path}`]);
}

describe("guarded rollout — interactive autonomy database (issue #498)", () => {
  it("bootstraps a configured-but-missing autonomy database strictly between containment and pointer activation", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "databases", "autonomy.sqlite");
    setAutonomyEnv(fixture, autonomyPath);
    addAutonomyToAllowlist(fixture, autonomyPath);

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(autonomyPath)).toBe(true);
    const db = new Database(autonomyPath, { readonly: true, fileMustExist: true });
    expect(Number(db.pragma("user_version", { simple: true }))).toBe(CURRENT_SCHEMA_VERSION);
    const provenance = JSON.parse(
      String(db.prepare("SELECT value FROM settings WHERE key = ?").get("agent_bridge_database_provenance")?.value ?? "{}"),
    );
    expect(provenance.role).toBe("interactive");
    db.close();

    const artifacts = artifactDir(fixture);
    expect(existsSync(join(artifacts, "autonomy-bootstrap-evidence.json"))).toBe(true);
    const bootstrapEvidence = JSON.parse(readFileSync(join(artifacts, "autonomy-bootstrap-evidence.json"), "utf8"));
    expect(bootstrapEvidence.databases[0].role).toBe("interactive");
    expect(bootstrapEvidence.databases[0].path).toBe(autonomyPath);

    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");
    expect(ledger.indexOf("phase=CONTAINED")).toBeGreaterThanOrEqual(0);
    expect(ledger.indexOf("phase=CONTAINED")).toBeLessThan(ledger.indexOf("phase=AUTONOMY_DB_BOOTSTRAPPED"));
    expect(ledger.indexOf("phase=AUTONOMY_DB_BOOTSTRAPPED")).toBeLessThan(ledger.indexOf("phase=SERVICES_STARTING"));

    const log = actions(fixture);
    expect(log.indexOf("systemctl:stop")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("systemctl:stop")).toBeLessThan(log.indexOf("systemctl:start"));

    // It appears in the post-start inventory, alongside the pre-existing
    // primary interactive database, with unambiguous `interactive` role.
    const postStart = JSON.parse(readFileSync(join(artifacts, "post-start-evidence.json"), "utf8"));
    const autonomyEntry = postStart.databases.find((entry: any) => entry.path === autonomyPath);
    expect(autonomyEntry).toBeTruthy();
    expect(autonomyEntry.role).toBe("interactive");
    const primaryEntry = postStart.databases.find((entry: any) => entry.path === fixture.dbPaths[3]);
    expect(primaryEntry).toBeTruthy();
    expect(primaryEntry.role).toBe("interactive");
  }, 20_000);

  it("does not create a second database and leaves single-DB behavior unchanged when the env var is absent", () => {
    const fixture = createFixture();

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = artifactDir(fixture);
    expect(existsSync(join(artifacts, "autonomy-bootstrap-evidence.json"))).toBe(false);
    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");
    expect(ledger).not.toContain("phase=AUTONOMY_DB_BOOTSTRAPPED");
    const postStart = JSON.parse(readFileSync(join(artifacts, "post-start-evidence.json"), "utf8"));
    expect(postStart.databases).toHaveLength(fixture.dbPaths.length);
    for (const path of fixture.dbPaths) {
      expect(postStart.databases.some((entry: any) => entry.path === path)).toBe(true);
    }
  }, 20_000);

  it("flows an already-existing autonomy database through as an ordinary database with no bootstrap call", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "databases", "autonomy.sqlite");
    setAutonomyEnv(fixture, autonomyPath);
    addAutonomyToAllowlist(fixture, autonomyPath);
    // Pre-create it with the same legacy shape the fixture's other
    // already-present databases use, so it passes the pre-containment `-f`
    // existence check and ordinary migration as an already-present database.
    createLegacyDb(autonomyPath);

    const result = runRollout(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const artifacts = artifactDir(fixture);
    expect(existsSync(join(artifacts, "autonomy-bootstrap-evidence.json"))).toBe(false);
    const ledger = readFileSync(join(artifacts, "phase-ledger.log"), "utf8");
    expect(ledger).not.toContain("phase=AUTONOMY_DB_BOOTSTRAPPED");
    const verify = new Database(autonomyPath, { readonly: true });
    expect(Number(verify.pragma("user_version", { simple: true }))).toBe(CURRENT_SCHEMA_VERSION);
    verify.close();
  }, 20_000);

  it("still dies on the inventory bijection when the autonomy path is in the unit env but missing from the fixed allowlist", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "databases", "autonomy.sqlite");
    setAutonomyEnv(fixture, autonomyPath);
    // Deliberately not added to the config's allowlist.

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/database inventory counts differ|discovered database missing from root allowlist/i);
    expect(existsSync(autonomyPath)).toBe(false);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });

  it("still dies on the inventory bijection when the autonomy path is in the fixed allowlist but not resolved from the unit env", () => {
    const fixture = createFixture();
    const autonomyPath = join(fixture.root, "databases", "autonomy.sqlite");
    addAutonomyToAllowlist(fixture, autonomyPath);
    // Deliberately not set in the interactive unit's env.

    const result = runRollout(fixture);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/missing database or symlinked database/i);
    expect(actions(fixture)).not.toContain("systemctl:stop");
  });
});
