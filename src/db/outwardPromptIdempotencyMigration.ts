import type Database from "better-sqlite3";

/** Version 26: retain Desk retry receipts on the canonical Bridge Run row. */
export function applyOutwardPromptIdempotencyMigration(db: Database.Database, _role?: string): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bridge_runs'").get();
  if (!table) return;
  const columns = new Set((db.prepare("PRAGMA table_info(bridge_runs)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("client_request_id")) db.exec("ALTER TABLE bridge_runs ADD COLUMN client_request_id TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS bridge_runs_outward_client_request
    ON bridge_runs(surface_identity, chat_id, client_request_id)
    WHERE client_request_id IS NOT NULL`);
}
