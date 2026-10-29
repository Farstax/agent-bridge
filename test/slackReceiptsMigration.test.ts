import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION, UnsupportedSchemaVersionError, applyMigrations } from "../src/db/schema.js";
import { openDb } from "../src/db.js";
import { migrationGrowthClass } from "../src/db/schema.js";

describe("schema v20 slack receipts (#943)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "slack-migration-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a v19 database preserving health and autonomous receipts, then admits slack rows", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(26);
    const path = join(dir, "bridge.sqlite");
    const raw = new Database(path);
    // Build a current v19 image by running the registered plan to v19 semantics.
    applyMigrations(raw);
    raw.exec("DROP INDEX IF EXISTS bridge_runs_outward_client_request");
    raw.exec("ALTER TABLE bridge_runs DROP COLUMN client_request_id");
    raw.pragma("user_version = 19");
    raw.exec("DROP INDEX IF EXISTS idx_event_receipts_source_kind");
    raw.exec("ALTER TABLE event_receipts RENAME TO event_receipts_new");
    raw.exec(`CREATE TABLE event_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('health', 'autonomous')), event_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, received_at TEXT NOT NULL, occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}', authority_scope TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','run_created','completed','failed','cancelled')),
      run_id TEXT, result_reference TEXT, error_class TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id))`);
    raw.exec("DROP TABLE event_receipts_new");
    raw.prepare(`INSERT INTO event_receipts (event_id, source, event_kind, idempotency_key, received_at, occurred_at, authority_scope, status)
      VALUES ('h1','health','report','k-health','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','scope','completed'),
             ('a1','autonomous','wake','k-auto','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','scope','received')`).run();
    expect(() => raw.prepare("INSERT INTO event_receipts (event_id, source, event_kind, idempotency_key, received_at, occurred_at, authority_scope) VALUES ('s','slack','e','k','t','t','s')").run()).toThrow(/CHECK/);
    raw.close();

    const db = openDb(path);
    expect(Number(db.raw.pragma("user_version", { simple: true }))).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.getEventReceiptByIdempotencyKey("k-health")).toMatchObject({ source: "health", status: "completed" });
    expect(db.getEventReceiptByIdempotencyKey("k-auto")).toMatchObject({ source: "autonomous", status: "received" });
    const admitted = db.admitEventReceipt({
      event_id: "Ev1", source: "slack", event_kind: "events_api", idempotency_key: "slack:T:A:Ev1",
      received_at: "t", occurred_at: "t", payload_json: "{}", authority_scope: "slack:T:A",
    });
    expect(admitted.created).toBe(true);
    expect(db.claimEventReceiptDispatch(admitted.receipt.id)).toBe(true);
    db.finishEventReceipt(admitted.receipt.id, { status: "ambiguous" });
    expect(db.getEventReceipt(admitted.receipt.id)?.status).toBe("ambiguous");
    expect(db.raw.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("refuses a database newer than the running code (no silent downgrade)", () => {
    const path = join(dir, "future.sqlite");
    const raw = new Database(path);
    raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(path)).toThrow(UnsupportedSchemaVersionError);
  });

  it("declares a copy-class disk-growth contract for the rebuild", () => {
    expect(migrationGrowthClass(19)).toBe("copy");
    expect(migrationGrowthClass(20)).toBe("none");
  });

  it("accepts the slack database role", async () => {
    const { canonicalSchemaTablesForRole } = await import("../src/db/schemaContract.js");
    expect(canonicalSchemaTablesForRole("slack")).toContain("event_receipts");
  });
});
