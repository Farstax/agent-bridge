import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_ROLES } from "../src/db/schemaContract.js";
import { applyMigrations, schemaTablesForRole } from "../src/db/schema.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const LEGACY_WORKER_TABLES = [
  "work_items",
  "work_jobs",
  "approvals",
  "github_links",
  "feature_plans",
  "work_item_plans",
  "role_assignments",
  "role_assignment_revisions",
] as const;

describe("Engineering Worker removal boundary", () => {
  it("has no Worker runtime entrypoint or service", () => {
    expect(existsSync(resolve(root, "src/index-worker.ts"))).toBe(false);
    expect(existsSync(resolve(root, "systemd/agent-bridge-worker-bot.service"))).toBe(false);
    expect(read("scripts/releaseManifest.mjs")).not.toContain("src/index-worker.ts");
    expect(read("scripts/release-activate.py")).not.toContain("src/index-worker.ts");
  });

  it("keeps interactive execution on the ordinary provider fallback path", () => {
    expect(read("src/index-interactive.ts")).not.toContain("WORKER_CLI_CHAIN");
    expect(read("src/index-discord-interactive.ts")).not.toContain("WORKER_CLI_CHAIN");
    expect(read("src/interactiveBot.ts")).not.toContain("WorkerFallbackChain");
  });

  it("does not expose live work-job execution through BridgeDb", () => {
    const db = read("src/db.ts");
    expect(db).not.toContain("claimNextWorkJob");
    expect(db).not.toContain("createWorkJob");
    expect(db).not.toContain("recoverExpiredWorkJobs");
  });

  it("does not include legacy Worker tables in the current schema", () => {
    const tables = new Set(schemaTablesForRole("shared"));
    for (const table of LEGACY_WORKER_TABLES) expect(tables.has(table)).toBe(false);
  });

  it("drops legacy Worker tables when upgrading a schema-v8 database", () => {
    const db = new Database(":memory:");
    try {
      for (const table of LEGACY_WORKER_TABLES) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
      db.pragma("user_version = 8");

      applyMigrations(db);

      const remaining = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
      );
      for (const table of LEGACY_WORKER_TABLES) expect(remaining.has(table)).toBe(false);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("does not expose a current Worker database role", () => {
    expect(DATABASE_ROLES).not.toContain("worker");
  });
});
