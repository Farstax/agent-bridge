import type Database from "better-sqlite3";

/**
 * Rebuild pending_messages with no-coercion affinity for external surface
 * coordinates. SQLite INTEGER affinity converts numeric-looking Discord
 * Snowflake strings to integers; better-sqlite3 can then materialize values
 * beyond Number.MAX_SAFE_INTEGER as lossy JavaScript numbers.
 *
 * BLOB affinity performs no coercion: string-bound Discord IDs remain TEXT,
 * while existing/bound numeric Telegram IDs remain INTEGER storage values.
 * Existing Discord rows are cast back to TEXT during the rebuild because the
 * old INTEGER affinity may already have coerced their original strings.
 */
export function applyPendingSurfaceCoordinatesMigration(raw: Database.Database): void {
  raw.pragma("legacy_alter_table = ON");
  try {
    raw.exec(`
      ALTER TABLE pending_messages RENAME TO pending_messages_migrate_tmp;

      CREATE TABLE pending_messages (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        surface              TEXT NOT NULL DEFAULT 'legacy',
        chat_key             TEXT NOT NULL,
        prompt               TEXT NOT NULL,
        chat_id              BLOB NOT NULL,
        thread_id            BLOB,
        chat_type            TEXT NOT NULL DEFAULT 'private',
        user_id              BLOB,
        state                TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed')),
        claim_run_id         TEXT,
        claim_acquisition_id TEXT,
        claimed_at           TEXT,
        attachments_json     TEXT NOT NULL DEFAULT '[]',
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      INSERT INTO pending_messages (
        id, surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id,
        state, claim_run_id, claim_acquisition_id, claimed_at,
        attachments_json, created_at
      )
      SELECT
        id,
        surface,
        chat_key,
        prompt,
        CASE WHEN surface = 'discord:interactive' THEN CAST(chat_id AS TEXT) ELSE chat_id END,
        CASE WHEN surface = 'discord:interactive' AND thread_id IS NOT NULL THEN CAST(thread_id AS TEXT) ELSE thread_id END,
        chat_type,
        CASE WHEN surface = 'discord:interactive' AND user_id IS NOT NULL THEN CAST(user_id AS TEXT) ELSE user_id END,
        state,
        claim_run_id,
        claim_acquisition_id,
        claimed_at,
        attachments_json,
        created_at
      FROM pending_messages_migrate_tmp;

      DROP TABLE pending_messages_migrate_tmp;
      CREATE INDEX idx_pending_msgs_surface_chat_key
        ON pending_messages(surface, chat_key, id);
    `);
  } finally {
    raw.pragma("legacy_alter_table = OFF");
  }
}
