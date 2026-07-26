import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "../src/db/dropLegacyPromptOverridesMigration.js";
import { openProductionDb } from "../src/db.js";
import { applyMigrationsUpTo, CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const roots: string[] = [];

function createVersion2Database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-rollout-role-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const raw = new Database(path);
  applyMigrationsUpTo(raw, [
    { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
  ], 2);
  raw.close();
  return path;
}

function runRolloutDb(mode: "inspect" | "migrate" | "validate", path: string): {
  databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
} {
  const stdout = execFileSync(process.execPath, [
    "--import",
    "tsx",
    migrationScript,
    mode,
    "--db",
    path,
    "--evidence",
    "-",
  ], { encoding: "utf8" });
  return JSON.parse(stdout) as {
    databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema 3 rollout qualification", () => {
  it("classifies exact schema 2 as migratable, then validates schema 3 with both dormant role tables", () => {
    const path = createVersion2Database();

    const before = runRolloutDb("inspect", path).databases[0];
    expect(before).toMatchObject({ schemaVersion: 2, schema: "migratable" });
    expect(before.tables).not.toContain("role_assignment_revisions");
    expect(before.tables).not.toContain("role_assignments");

    const migrated = runRolloutDb("migrate", path).databases[0];
    expect(migrated).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, schema: "current" });
    expect(migrated.tables).toEqual(expect.arrayContaining([
      "role_assignment_revisions",
      "role_assignments",
    ]));

    const validated = runRolloutDb("validate", path).databases[0];
    expect(validated).toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION, schema: "current" });
  });

  it("rejects schema 3 when a role-assignment table has the wrong exact columns", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);

    const raw = new Database(path);
    raw.exec(`
      DROP TABLE role_assignments;
      CREATE TABLE role_assignments (
        revision_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        primary_cli TEXT NOT NULL,
        PRIMARY KEY(revision_id, role)
      );
    `);
    raw.close();

    expect(() => runRolloutDb("validate", path)).toThrow(/unknown schema after migration/i);
  });

  it("rejects schema 3 with the right column names but missing constraints, foreign key, and indexes", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);
    const raw = new Database(path);
    raw.exec(`
      DROP TABLE role_assignments;
      CREATE TABLE role_assignments (
        revision_id TEXT, role TEXT, selection_mode TEXT,
        primary_cli TEXT, primary_model TEXT, fallbacks_json TEXT
      );
    `);
    raw.close();

    expect(() => openProductionDb(path, { serviceId: "test:malformed-current" }))
      .toThrow(/unexpected role_assignments schema/i);
    expect(() => runRolloutDb("validate", path)).toThrow(/unknown schema after migration/i);
  });

  it("rejects schema 3 when an unexpected surplus role-assignment index exists", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);
    const raw = new Database(path);
    raw.exec("CREATE INDEX unexpected_extra_role_index ON role_assignments(primary_cli);");
    raw.close();

    expect(() => openProductionDb(path, { serviceId: "test:surplus-role-index" }))
      .toThrow(/unexpected role_assignments indexes/i);
    expect(() => runRolloutDb("validate", path)).toThrow(/unknown schema after migration/i);
  });

  it("rejects schema 3 when the required latest-revision index uses ascending order", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);
    const raw = new Database(path);
    raw.exec(`
      DROP INDEX idx_role_assignment_revisions_scope_revision;
      CREATE INDEX idx_role_assignment_revisions_scope_revision
        ON role_assignment_revisions(scope_key, revision ASC);
    `);
    raw.close();

    expect(() => openProductionDb(path, { serviceId: "test:ascending-role-index" }))
      .toThrow(/unexpected role_assignment_revisions indexes/i);
    expect(() => runRolloutDb("validate", path)).toThrow(/unknown schema after migration/i);
  });

  it("rejects schema 3 when same-metadata role constraints omit code_worker", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);
    const raw = new Database(path);
    raw.exec(`
      DROP TABLE role_assignments;
      CREATE TABLE role_assignments (
        revision_id      INTEGER NOT NULL,
        role             TEXT NOT NULL CHECK (role IN ('technical_lead', 'documentation_steward')),
        selection_mode   TEXT NOT NULL CHECK (selection_mode IN ('automatic', 'recommended', 'manual')),
        primary_cli      TEXT NOT NULL,
        primary_model    TEXT NOT NULL,
        fallbacks_json   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fallbacks_json)),
        PRIMARY KEY(revision_id, role),
        FOREIGN KEY(revision_id) REFERENCES role_assignment_revisions(id) ON DELETE CASCADE
      );
    `);
    raw.close();

    expect(() => openProductionDb(path, { serviceId: "test:altered-role-constraint" }))
      .toThrow(/unexpected role_assignments constraints/i);
    expect(() => runRolloutDb("validate", path)).toThrow(/unknown schema after migration/i);
  });

  it("rejects an exact schema with a pre-existing foreign-key violation", () => {
    const path = createVersion2Database();
    runRolloutDb("migrate", path);
    const raw = new Database(path);
    raw.pragma("foreign_keys = OFF");
    raw.prepare(`
      INSERT INTO role_assignments
        (revision_id, role, selection_mode, primary_cli, primary_model, fallbacks_json)
      VALUES (999, 'technical_lead', 'manual', 'claude', 'safe-model', '[]')
    `).run();
    raw.close();

    expect(() => openProductionDb(path, { serviceId: "test:orphan-current" }))
      .toThrow(/foreign key/i);
    expect(() => runRolloutDb("validate", path)).toThrow(/foreign key/i);
  });
});
