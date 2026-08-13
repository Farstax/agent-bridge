import type Database from "better-sqlite3";

export const DATABASE_ROLES = ["shared", "discord", "health", "interactive", "worker"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

const BASE_TABLES = [
  "advisor_attempts", "advisor_calls", "approvals", "bridge_events", "bridge_runs", "bridge_state",
  "compaction_attempts", "conversation_summaries", "conversation_turns", "execution_locks", "feature_plans",
  "github_links", "health_context", "pending_messages", "project_memories", "project_memories_fts",
  "project_memories_fts_config", "project_memories_fts_content", "project_memories_fts_data",
  "project_memories_fts_docsize", "project_memories_fts_idx", "prompts", "reconciliation_audit",
  "role_assignment_revisions", "role_assignments", "settings", "sqlite_sequence", "work_item_plans",
  "work_items", "work_jobs",
] as const;

const ROLE_TABLES: Record<DatabaseRole, readonly string[]> = {
  shared: BASE_TABLES, discord: BASE_TABLES, interactive: BASE_TABLES, worker: BASE_TABLES,
  health: [...BASE_TABLES, "health_plugin_reports"],
};

export function canonicalSchemaTablesForRole(role: string = "shared"): readonly string[] {
  if (!DATABASE_ROLES.includes(role as DatabaseRole)) throw new Error(`unknown database role: ${role}`);
  return ROLE_TABLES[role as DatabaseRole];
}

/** Durable role-specific schema is created here, not by feature constructors. */
export function applyRoleSchema(db: Database.Database, role: string = "shared"): void {
  if (role === "health") {
    db.exec(`CREATE TABLE IF NOT EXISTS health_plugin_reports (
      plugin_name TEXT PRIMARY KEY, report_json TEXT NOT NULL, saved_at INTEGER NOT NULL
    )`);
    return;
  }
  canonicalSchemaTablesForRole(role);
}
