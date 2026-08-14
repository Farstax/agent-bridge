import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { LEGACY_WORKER_TABLES } from "../src/db/dropLegacyWorkerTablesMigration.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

const migrationScript = fileURLToPath(new URL("../scripts/rollout-db.ts", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-schema-rollout-"));
  dirs.push(dir);
  return dir;
}

function runRollout(mode: "inspect" | "migrate" | "validate", path: string) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxCli, migrationScript, mode, "--db", path, "--database-role", `${path}=interactive`],
      { encoding: "utf8", env: { ...process.env } },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Worker schema cleanup through guarded rollout", () => {
  it("accepts a pre-v9 database with legacy Worker tables, migrates it, and validates the Worker-free schema", () => {
    const path = join(tempDir(), "bridge.sqlite");
    openDb(path, { databaseRole: "interactive" }).close();

    const legacy = new Database(path);
    for (const table of LEGACY_WORKER_TABLES) legacy.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    legacy.pragma("user_version = 8");
    legacy.close();

    const inspection = runRollout("inspect", path);
    expect(inspection.status, inspection.stderr).toBe(0);

    const migration = runRollout("migrate", path);
    expect(migration.status, migration.stderr).toBe(0);

    const current = new Database(path, { readonly: true });
    expect(current.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const tables = new Set(
      (current.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    for (const table of LEGACY_WORKER_TABLES) expect(tables.has(table)).toBe(false);
    expect(current.pragma("foreign_key_check")).toEqual([]);
    current.close();

    const validation = runRollout("validate", path);
    expect(validation.status, validation.stderr).toBe(0);
  });

  it("fails closed if a current-version database still contains any legacy Worker table", () => {
    const path = join(tempDir(), "bridge.sqlite");
    openDb(path, { databaseRole: "interactive" }).close();

    const corrupted = new Database(path);
    corrupted.exec("CREATE TABLE work_items (id INTEGER PRIMARY KEY)");
    corrupted.close();

    const validation = runRollout("validate", path);
    expect(validation.status).not.toBe(0);
    expect(validation.stderr).toMatch(/legacy Worker table/i);
  });
});
