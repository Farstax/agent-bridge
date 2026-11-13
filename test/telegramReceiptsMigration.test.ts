import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, migrationGrowthClass } from "../src/db/schema.js";
import { applySlackReceiptsMigration } from "../src/db/slackReceiptsMigration.js";

describe("schema v27 Telegram polling receipts (#1221)", () => {
  it("upgrades the existing receipt table preserving source, status and identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "telegram-receipt-migrate-"));
    const path = join(dir, "interactive.sqlite");
    try {
      openDb(path).close();
      const old = new Database(path);
      old.pragma("foreign_keys = OFF");
      applySlackReceiptsMigration(old); // Restore the exact v26 source CHECK.
      old.pragma("user_version = 26");
      old.pragma("foreign_keys = ON");
      old.prepare(`INSERT INTO event_receipts
        (event_id, source, event_kind, idempotency_key, received_at, occurred_at, authority_scope, status)
        VALUES ('slack1','slack','events_api','slack:1','2026-01-01','2026-01-01','scope','completed'),
               ('health1','health','report','health:1','2026-01-01','2026-01-01','scope','received')`).run();
      expect(() => old.prepare(`INSERT INTO event_receipts
        (event_id, source, event_kind, idempotency_key, received_at, occurred_at, authority_scope)
        VALUES ('tg','telegram','message','telegram:1','2026-01-01','2026-01-01','scope')`).run()).toThrow(/CHECK/);
      old.close();

      const migrated = openDb(path);
      expect(migrated.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrated.getEventReceiptByIdempotencyKey("slack:1")).toMatchObject({ source: "slack", status: "completed" });
      expect(migrated.getEventReceiptByIdempotencyKey("health:1")).toMatchObject({ source: "health", status: "received" });
      expect(migrated.admitEventReceipt({
        event_id: "telegram:1", source: "telegram", event_kind: "message",
        idempotency_key: "telegram:1", received_at: "2026-01-01",
        occurred_at: "2026-01-01", payload_json: "{}", authority_scope: "telegram:interactive",
      }).created).toBe(true);
      expect(migrated.raw.pragma("foreign_key_check")).toEqual([]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares a copy-class disk admission for the existing-table rebuild", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(27);
    expect(migrationGrowthClass(26)).toBe("copy");
    expect(migrationGrowthClass(27)).toBe("none");
  });
});
