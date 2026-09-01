import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/schema.js";
import { canonicalSchemaTablesForRole } from "../src/db/schemaContract.js";
import { openDb } from "../src/db.js";
import { fileURLToPath } from "node:url";

const rolloutScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));

describe("canonical production schema contract", () => {
  it("derives the health table from the health migration contract", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-schema-contract-"));
    const db = new Database(join(root, "health.sqlite"));
    try {
      applyMigrations(db, undefined, "health");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_plugin_reports'").get()).toBeTruthy();
      expect(canonicalSchemaTablesForRole("health")).toContain("health_plugin_reports");
      expect(canonicalSchemaTablesForRole("shared")).not.toContain("health_plugin_reports");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps unmanaged tables outside the canonical contract", () => {
    expect(canonicalSchemaTablesForRole("health")).not.toContain("unmanaged_table");
  });

  it("accepts a canonical health table without a rollout-validator table-list edit", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-schema-contract-rollout-"));
    const path = join(root, "health.sqlite");
    try {
      openDb(path, { databaseRole: "health" }).close();
      const rawBeforeValidate = new Database(path, { readonly: true });
      const pendingColumns = (rawBeforeValidate.prepare("PRAGMA table_info(pending_messages)").all() as Array<{ name: string }>).map((row) => row.name);
      rawBeforeValidate.close();
      expect(pendingColumns).toContain("scheduled_occurrence_key");
      const output = execFileSync(process.execPath, ["--import", "tsx", rolloutScript, "validate", "--db", path, "--database-role", `${path}=health`, "--evidence", "-"], { encoding: "utf8" });
      expect(JSON.parse(output).databases[0].schema).toBe("current");
      const raw = new Database(path);
      raw.exec("CREATE TABLE unmanaged_table (id INTEGER PRIMARY KEY)");
      raw.close();
      try {
        execFileSync(process.execPath, ["--import", "tsx", rolloutScript, "validate", "--db", path, "--database-role", `${path}=health`, "--evidence", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        throw new Error("expected unmanaged schema to fail closed");
      } catch (error) {
        expect(String(error)).toMatch(/unmanaged_table|status: 1/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let the health report feature create its durable table", async () => {
    const { HealthReportStore } = await import("../src/health/reports.js");
    const db = new Database(":memory:");
    try {
      new HealthReportStore(db);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_plugin_reports'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
