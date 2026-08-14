import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION, MigrationForeignKeyViolationError, type Migration } from "../src/db/schema.js";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { LegacyPromptOverridesPresentError } from "../src/db/dropLegacyPromptOverridesMigration.js";
import { LEGACY_WORKER_TABLES } from "../src/db/dropLegacyWorkerTablesMigration.js";
import { openDb } from "../src/db.js";
import { createLegacyFixture, ROLE_FIXTURES } from "./support/legacyDbFixture";

function tempDbPath(role: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-schema-${role}-`));
  return { dir, path: join(dir, "bridge.sqlite") };
}


describe("database schema versioning", () => {
  it.each(ROLE_FIXTURES)("migrates the %s legacy database role from a fixed pre-versioned fixture", (role) => {
    const fixture = tempDbPath(role);
    try {
      createLegacyFixture(fixture.path);
      const db = openDb(fixture.path, { serviceId: `schema-test:${role}` });
      expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);

      // Historical repairs still run before the final Worker cleanup:
      // execution_locks gains acquisition_id, provider session columns are
      // normalized, and the conversation/memory tables introduced after
      // versioning exist in the current schema.
      const lockColumns = (db.raw.prepare(`PRAGMA table_info(execution_locks)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(lockColumns).toContain("acquisition_id");

      const bridgeStateColumns = (db.raw.prepare(`PRAGMA table_info(bridge_state)`).all() as Array<{ name: string }>)
        .map((c) => c.name);
      expect(bridgeStateColumns).toEqual(expect.arrayContaining(["claude_session_id", "antigravity_session_id", "kimchi_session_id"]));

      for (const table of ["conversation_turns", "pending_messages", "conversation_summaries", "compaction_attempts", "project_memories"]) {
        expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
      }
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeUndefined();

      // The legacy fixture contains real Worker rows and relationships. They
      // are intentionally retired by v9 rather than preserved as inert data.
      for (const table of LEGACY_WORKER_TABLES) {
        expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
      }
      expect(db.raw.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.raw.pragma("foreign_key_check")).toEqual([]);

      // No migration temp/scratch tables remain.
      const tableNames = (db.raw.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'`
      ).all() as Array<{ name: string }>).map((t) => t.name);
      expect(tableNames.filter((name) => name.includes("_migrate_tmp") || name.includes("_legacy_migration"))).toEqual([]);
      db.close();

      // Reopening an already-current database must not re-run historical
      // repair or cleanup paths — user_version is authoritative.
      const reopened = openDb(fixture.path, { serviceId: `schema-test:${role}` });
      expect(reopened.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      reopened.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("keeps a fresh database at the current version after an idempotent reopen", () => {
    const fixture = tempDbPath("fresh");
    try {
      const first = openDb(fixture.path);
      first.close();
      const second = openDb(fixture.path);
      expect(second.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      second.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

it("drops an empty prompts table when migrating a version 1 database", () => {
  const fixture = tempDbPath("prompt-retirement-empty");
  try {
    createLegacyFixture(fixture.path);
    const raw = new Database(fixture.path);
    applyMigrationsUpTo(raw, [
      { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    ], 1);
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeTruthy();
    raw.close();

    const migrated = openDb(fixture.path, { serviceId: "schema-test:prompt-retirement" });
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'").get()).toBeUndefined();
    migrated.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

it("rolls back prompt-table retirement when an unexpected row exists", () => {
  const fixture = tempDbPath("prompt-retirement-populated");
  try {
    createLegacyFixture(fixture.path);
    const raw = new Database(fixture.path);
    applyMigrationsUpTo(raw, [
      { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    ], 1);
    raw.prepare("INSERT INTO prompts (name, prompt_text) VALUES (?, ?)").run("unexpected", "legacy value");

    expect(() => applyMigrations(raw)).toThrow(LegacyPromptOverridesPresentError);
    expect(raw.pragma("user_version", { simple: true })).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM prompts").get()).toEqual({ count: 1 });
    raw.close();
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

  it("fails closed for a future schema version without changing the database, WAL mode, or sidecar files", () => {
    const fixture = tempDbPath("future");
    try {
      const raw = new Database(fixture.path);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = 99;");
      raw.close();

      const beforeHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
      const walPath = `${fixture.path}-wal`;
      const shmPath = `${fixture.path}-shm`;

      expect(() => openDb(fixture.path)).toThrow(/unsupported database schema version 99/i);

      // No WAL/shm sidecar files were ever created — proves WAL mode was
      // never enabled before the rejection.
      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);

      const afterHash = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
      expect(afterHash).toBe(beforeHash);

      const verify = new Database(fixture.path, { readonly: true });
      expect(verify.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(verify.pragma("user_version", { simple: true })).toBe(99);
      expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'sentinel'").get()).toBeTruthy();
      verify.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("fails closed for a negative schema version without enabling WAL mode", () => {
    const fixture = tempDbPath("negative");
    try {
      const raw = new Database(fixture.path);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = -5;");
      raw.close();

      const walPath = `${fixture.path}-wal`;
      const shmPath = `${fixture.path}-shm`;

      expect(() => openDb(fixture.path)).toThrow(/unsupported database schema version -5/i);

      expect(existsSync(walPath)).toBe(false);
      expect(existsSync(shmPath)).toBe(false);

      const verify = new Database(fixture.path, { readonly: true });
      expect(verify.pragma("journal_mode", { simple: true })).toBe("delete");
      expect(verify.pragma("user_version", { simple: true })).toBe(-5);
      verify.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rolls back schema changes and user_version when an intermediate migration fails", () => {
    const fixture = tempDbPath("rollback");
    const migrations: readonly Migration[] = [
      { version: 1, name: "create_probe", up: (db) => db.exec("CREATE TABLE probe(value TEXT)") },
      { version: 2, name: "fail_probe", up: (db) => {
        db.exec("ALTER TABLE probe ADD COLUMN changed INTEGER");
        throw new Error("deliberate migration failure");
      } },
    ];
    try {
      const raw = new Database(fixture.path);
      // Uses the explicit-target test helper (targetVersion 2) because this
      // explicit-target helper injects a deliberate failing plan without
      // changing the production migration registry. Production code always
      // calls applyMigrations(), which never accepts an override.
      expect(() => applyMigrationsUpTo(raw, migrations, 2)).toThrow("deliberate migration failure");
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toBeUndefined();
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rolls back when the target schema leaves a real dangling foreign key", () => {
    const fixture = tempDbPath("foreign-key-failure");
    const migrations: readonly Migration[] = [
      {
        version: 1,
        name: "create_related_tables",
        up: (db) => db.exec(`
          CREATE TABLE parent (id INTEGER PRIMARY KEY);
          CREATE TABLE child (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL,
            FOREIGN KEY(parent_id) REFERENCES parent(id)
          );
          INSERT INTO child (id, parent_id) VALUES (1, 999);
        `),
      },
    ];
    try {
      const raw = new Database(fixture.path);
      let caught: unknown;
      try {
        applyMigrationsUpTo(raw, migrations, 1);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MigrationForeignKeyViolationError);
      expect((caught as MigrationForeignKeyViolationError).violations).toEqual([
        expect.objectContaining({ table: "child", parent: "parent" }),
      ]);
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('parent', 'child')").all()).toEqual([]);
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("retires dangling foreign keys that exist only inside legacy Worker persistence", () => {
    const fixture = tempDbPath("worker-foreign-key-retirement");
    try {
      createLegacyFixture(fixture.path);
      const raw = new Database(fixture.path);
      raw.pragma("foreign_keys = OFF");
      raw.exec(`
        INSERT INTO approvals (id, work_item_id, job_id, approval_type, status, requested_by)
        VALUES (2, 1, 999, 'merge_pr', 'approved', 'nick');
      `);
      raw.pragma("foreign_keys = ON");

      applyMigrations(raw);

      expect(raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(raw.pragma("foreign_key_check")).toEqual([]);
      for (const table of LEGACY_WORKER_TABLES) {
        expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
      }
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("rejects a production migration plan that does not end exactly at CURRENT_SCHEMA_VERSION", () => {
    const fixture = tempDbPath("overshoot");
    const overshootMigrations: readonly Migration[] = [
      ...Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => ({
        version: i + 1,
        name: `step-${i + 1}`,
        up: () => undefined,
      })),
      { version: CURRENT_SCHEMA_VERSION + 1, name: "unexpected-extra-step", up: () => undefined },
    ];
    try {
      const raw = new Database(fixture.path);
      expect(() => applyMigrations(raw, overshootMigrations)).toThrow(
        `database migrations must end exactly at target schema version ${CURRENT_SCHEMA_VERSION}`,
      );
      expect(raw.pragma("user_version", { simple: true })).toBe(0);
      raw.close();
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
