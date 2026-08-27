import type Database from "better-sqlite3";

/** Adds durable canonical conversation provenance used by authorized history search. */
export function applyConversationScopeMigration(db: Database.Database): void {
  // arch-lint-allow-legacy-sql: schema migration owns this conversation_turns inspection
  const columns = new Set((db.prepare("PRAGMA table_info(conversation_turns)").all() as Array<{ name: string }>).map((row) => row.name));
  // arch-lint-allow-legacy-sql: schema migration owns this conversation_turns column addition
  if (!columns.has("surface_identity")) db.exec("ALTER TABLE conversation_turns ADD COLUMN surface_identity TEXT");
  // arch-lint-allow-legacy-sql: schema migration owns this conversation_turns column addition
  if (!columns.has("owner_key")) db.exec("ALTER TABLE conversation_turns ADD COLUMN owner_key TEXT");
  // arch-lint-allow-legacy-sql: schema migration owns these conversation_turns indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conv_turns_conversation_scope
      ON conversation_turns(surface_identity, chat_key, id);
    CREATE INDEX IF NOT EXISTS idx_conv_turns_owner_scope
      ON conversation_turns(owner_key, id);
  `);
}
