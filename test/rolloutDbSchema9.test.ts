import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "../src/db/dropLegacyPromptOverridesMigration.js";
import { applyMigrationsUpTo, CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import { applyRoleAssignmentsMigration } from "../src/db/roleAssignmentsMigration.js";
import { applyReconciliationAuditMigration } from "../src/db/reconciliationAuditMigration.js";
import { applyMemoryResolutionMigration } from "../src/db/memoryResolutionMigration.js";
import { applyHealthSchemaMigration } from "../src/db/healthSchemaMigration.js";
import { applyEventReceiptsMigration } from "../src/db/eventReceiptsMigration.js";
import { applyAutonomousGoalsMigration } from "../src/db/autonomousGoalsMigration.js";

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const roots: string[] = [];

function createVersion8Database(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-rollout-schema9-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const db = new Database(path);
  applyMigrationsUpTo(db, [
    { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
    { version: 3, name: "add-dormant-role-assignments", up: applyRoleAssignmentsMigration },
    { version: 4, name: "add-reconciliation-audit", up: applyReconciliationAuditMigration },
    { version: 5, name: "add-memory-resolution", up: applyMemoryResolutionMigration },
    { version: 6, name: "add-health-report-read-model", up: applyHealthSchemaMigration },
    { version: 7, name: "add-health-event-receipts", up: applyEventReceiptsMigration },
    { version: 8, name: "add-autonomous-goals", up: applyAutonomousGoalsMigration },
  ], 8);
  db.exec(`
    INSERT INTO work_items (id, kind, source, title, created_by)
      VALUES (1, 'feature', 'manual', 'obsolete', 'worker');
    INSERT INTO work_jobs (id, work_item_id, task_type, idempotency_key)
      VALUES (1, 1, 'feature_plan', 'obsolete-job');
    INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at)
      VALUES ('stale-run', 'chat-1', 'codex', 'running', '2020-01-01T00:00:00Z');
  `);
  db.close();
  return path;
}

function runRollout(mode: "inspect" | "reconcile" | "migrate" | "validate", path: string): {
  databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
} {
  const args = ["--import", "tsx", migrationScript, mode, "--db", path, "--evidence", "-"];
  if (mode === "reconcile") args.push("--reason", "schema-9 regression test");
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" })) as {
    databases: Array<{ schemaVersion: number; schema: string; tables: string[] }>;
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schema 9 rollout classification", () => {
  it("keeps an unmigrated populated version-8 database out of reconciliation", () => {
    const path = createVersion8Database();
    const before = runRollout("inspect", path).databases[0];
    expect(before.schemaVersion).toBe(8);
    expect(before.schema).toBe("migratable");

    const reconciled = runRollout("reconcile", path).databases[0];
    expect(reconciled.schema).toBe("migratable");
    const beforeMigration = new Database(path, { readonly: true });
    expect(beforeMigration.prepare("SELECT COUNT(*) AS count FROM reconciliation_audit").get()).toEqual({ count: 0 });
    beforeMigration.close();

    const migrated = runRollout("migrate", path).databases[0];
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.tables).not.toContain("work_items");
    expect(migrated.tables).not.toContain("work_jobs");
    expect(runRollout("validate", path).databases[0].schema).toBe("current");
  });
});
