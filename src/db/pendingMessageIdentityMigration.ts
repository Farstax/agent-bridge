import type Database from "better-sqlite3";

const TABLE = "pending_messages";
const OLD_TABLE = "pending_messages_identity_migration_old";
const INDEX = "idx_pending_msgs_surface_chat_key";

/**
 * Preserve transport-native queued identities as text.
 *
 * Discord Snowflakes exceed JavaScript's safe integer range. Keeping these
 * fields in SQLite INTEGER columns allows better-sqlite3 to return imprecise
 * Numbers after queue/restart recovery. Rebuild the table and cast inside
 * SQLite so legacy 64-bit integer values never round-trip through JS.
 */
export function applyPendingMessageIdentityMigration(db: Database.Database): void {
  const table = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(TABLE) as { name: string } | undefined;
  if (!table) return;

  const stale = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(OLD_TABLE);
  if (stale) throw new Error(`${OLD_TABLE} already exists`);

  const columns = db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  const required = [
    "id",
    "surface",
    "chat_key",
    "prompt",
    "chat_id",
    "thread_id",
    "chat_type",
    "user_id",
    "state",
    "claim_run_id",
    "claim_acquisition_id",
    "claimed_at",
    "attachments_json",
    "created_at",
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`pending_messages migration missing columns: ${missing.join(", ")}`);
  }

  db.exec(`
    ALTER TABLE ${TABLE} RENAME TO ${OLD_TABLE};
    DROP INDEX IF EXISTS ${INDEX};

    CREATE TABLE ${TABLE} (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      surface              TEXT NOT NULL DEFAULT 'legacy',
      chat_key             TEXT NOT NULL,
      prompt               TEXT NOT NULL,
      chat_id              TEXT NOT NULL,
      thread_id            TEXT,
      chat_type            TEXT NOT NULL DEFAULT 'private',
      user_id              TEXT,
      state                TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed')),
      claim_run_id         TEXT,
      claim_acquisition_id TEXT,
      claimed_at           TEXT,
      attachments_json     TEXT NOT NULL DEFAULT '[]',
      created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    INSERT INTO ${TABLE} (
      id,
      surface,
      chat_key,
      prompt,
      chat_id,
      thread_id,
      chat_type,
      user_id,
      state,
      claim_run_id,
      claim_acquisition_id,
      claimed_at,
      attachments_json,
      created_at
    )
    SELECT
      id,
      surface,
      chat_key,
      prompt,
      CAST(chat_id AS TEXT),
      CASE WHEN thread_id IS NULL THEN NULL ELSE CAST(thread_id AS TEXT) END,
      chat_type,
      CASE WHEN user_id IS NULL THEN NULL ELSE CAST(user_id AS TEXT) END,
      state,
      claim_run_id,
      claim_acquisition_id,
      claimed_at,
      attachments_json,
      created_at
    FROM ${OLD_TABLE};

    DROP TABLE ${OLD_TABLE};

    CREATE INDEX ${INDEX}
      ON ${TABLE}(surface, chat_key, id);
  `);
}
