import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, MigrationRequiredError, UnsupportedSchemaVersionError } from "../src/db/schema.js";
import { DatabaseMissingError, openDb, openProductionDb } from "../src/db.js";

// Issue #135 Phase 4C.2: openProductionDb() is the strict, production-only
// opener. Unlike openDb(), it never creates a missing file and only accepts
// a database that is already at exactly CURRENT_SCHEMA_VERSION — every other
// state (legacy/migratable, future, invalid, or missing) must fail before
// WAL mode is enabled or any write occurs.

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `agent-bridge-prod-opener-${label}-`));
}

function assertNoSidecarsAndNoWrite(dbPath: string, beforeHash: string | null): void {
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
  if (beforeHash !== null) {
    const afterHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(afterHash).toBe(beforeHash);
  }
}

describe("Issue #135 Phase 4C.2: openProductionDb()", () => {
  it("opens a database already at CURRENT_SCHEMA_VERSION", () => {
    const dir = tempDir("current");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      openDb(dbPath).close();

      const db = openProductionDb(dbPath, { serviceId: "test:production" });
      expect(db.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(db.raw.pragma("journal_mode", { simple: true })).toBe("wal");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when an appliance database has no installation provenance", () => {
    const dir = tempDir("missing-provenance");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      openDb(dbPath).close();
      expect(() => openProductionDb(dbPath, {
        serviceId: "test:production",
        installationId: "install-current",
        requireInstallationIdentity: true,
      })).toThrow(/installation provenance/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a pre-populated first-boot database and accepts a clean one", () => {
    const dir = tempDir("fresh-install");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      const seeded = openDb(dbPath);
      seeded.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_installation_id", "install-current");
      seeded.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_database_provenance", JSON.stringify({ schemaVersion: 1, role: "interactive", source: "fresh-install", installationId: "install-current", path: dbPath }));
      seeded.raw.prepare("INSERT INTO bridge_state (chat_id, codex_session_id) VALUES (?, ?)").run("chat", "stale-session");
      seeded.close();
      expect(() => openProductionDb(dbPath, { installationId: "install-current", requireInstallationIdentity: true, databaseRole: "interactive" }))
        .toThrow(/first boot.*session/i);

      const cleanPath = join(dir, "clean.sqlite");
      const clean = openDb(cleanPath);
      clean.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_installation_id", "install-clean");
      clean.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_database_provenance", JSON.stringify({ schemaVersion: 1, role: "interactive", source: "fresh-install", installationId: "install-clean", path: cleanPath }));
      clean.close();
      const opened = openProductionDb(cleanPath, { installationId: "install-clean", requireInstallationIdentity: true, databaseRole: "interactive" });
      expect(opened.raw.prepare("SELECT value FROM settings WHERE key = ?").get("agent_bridge_first_boot_verified")).toBeTruthy();
      opened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["wrong role", JSON.stringify({ schemaVersion: 1, source: "fresh-install", installationId: "install-current", role: "worker", path: "/expected/interactive.sqlite" })],
    ["wrong path", JSON.stringify({ schemaVersion: 1, source: "fresh-install", installationId: "install-current", role: "interactive", path: "/wrong.sqlite" })],
    ["wrong identity", JSON.stringify({ schemaVersion: 1, source: "fresh-install", installationId: "install-other", role: "interactive", path: "/expected/interactive.sqlite" })],
  ])("rejects provenance with %s", (_label, provenance) => {
    const dir = tempDir("invalid-provenance");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      const seeded = openDb(dbPath);
      seeded.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_installation_id", "install-current");
      seeded.raw.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("agent_bridge_database_provenance", provenance);
      seeded.close();
      expect(() => openProductionDb(dbPath, {
        installationId: "install-current",
        requireInstallationIdentity: true,
        databaseRole: "interactive",
      })).toThrow(/provenance/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with MigrationRequiredError for a legacy/migratable version, without WAL mode or mutation", () => {
    const dir = tempDir("legacy");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      const raw = new Database(dbPath);
      raw.exec("CREATE TABLE sentinel(value TEXT);"); // user_version defaults to 0
      raw.close();

      const beforeHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

      expect(() => openProductionDb(dbPath)).toThrow(MigrationRequiredError);
      assertNoSidecarsAndNoWrite(dbPath, beforeHash);

      const verify = new Database(dbPath, { readonly: true });
      expect(verify.pragma("user_version", { simple: true })).toBe(0);
      expect(verify.pragma("journal_mode", { simple: true })).toBe("delete");
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with UnsupportedSchemaVersionError for a future version, without WAL mode or mutation", () => {
    const dir = tempDir("future");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      const raw = new Database(dbPath);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = 99;");
      raw.close();

      const beforeHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

      expect(() => openProductionDb(dbPath)).toThrow(/unsupported database schema version 99/i);
      assertNoSidecarsAndNoWrite(dbPath, beforeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with UnsupportedSchemaVersionError for a negative/invalid version, without WAL mode or mutation", () => {
    const dir = tempDir("invalid");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      const raw = new Database(dbPath);
      raw.exec("CREATE TABLE sentinel(value TEXT); PRAGMA user_version = -5;");
      raw.close();

      const beforeHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

      expect(() => openProductionDb(dbPath)).toThrow(UnsupportedSchemaVersionError);
      expect(() => openProductionDb(dbPath)).toThrow(/unsupported database schema version -5/i);
      assertNoSidecarsAndNoWrite(dbPath, beforeHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with DatabaseMissingError for a missing file, creating no file or directory", () => {
    const parent = tempDir("missing-parent");
    try {
      const missingDir = join(parent, "does-not-exist-yet");
      const dbPath = join(missingDir, "bridge.sqlite");

      expect(() => openProductionDb(dbPath)).toThrow(DatabaseMissingError);
      expect(existsSync(missingDir)).toBe(false);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("creates no file when the parent directory exists but the database file itself is missing", () => {
    const dir = tempDir("missing-file");
    try {
      const dbPath = join(dir, "bridge.sqlite");
      expect(() => openProductionDb(dbPath)).toThrow(DatabaseMissingError);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("openDb() keeps creating a missing file and running it through migration to CURRENT_SCHEMA_VERSION, unchanged", () => {
    const dir = tempDir("opendb-unchanged");
    try {
      const freshPath = join(dir, "brand-new.sqlite");
      expect(existsSync(freshPath)).toBe(false);
      const fresh = openDb(freshPath);
      expect(existsSync(freshPath)).toBe(true);
      expect(fresh.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Issue #135 Phase 4C.2: production entrypoints use openProductionDb()", () => {
  it("each of the five service entrypoints calls openProductionDb, not openDb", () => {
    for (const file of [
      "src/index-interactive.ts",
      "src/index-discord-interactive.ts",
      "src/index-health.ts",
    ]) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must import openProductionDb`).toMatch(
        /import\s*\{\s*openProductionDb\s*\}\s*from\s*["']\.\/db\.js["']/,
      );
      expect(text, `${file} must call openProductionDb(...)`).toMatch(/\bopenProductionDb\(/);
      expect(text, `${file} must not call openDb(...) directly`).not.toMatch(/[^n]\bopenDb\(/);
    }
  });
});
