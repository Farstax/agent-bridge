import type Database from "better-sqlite3";
import { LEGACY_WORKER_TABLES } from "./dropLegacyWorkerTablesMigration.js";
import { schemaTablesForRole } from "./schema.js";

export const DATABASE_ROLES = ["shared", "discord", "health", "interactive"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

/**
 * Tables the guarded rollout may legitimately encounter while inspecting a
 * database before migration. The actual current schema is still defined by
 * schemaTablesForRole() and contains no Worker tables; these legacy names are
 * recognized only so v1-v8 databases can reach the v9 cleanup migration.
 * Current-version validation separately rejects any legacy Worker table that
 * survives migration.
 */
export function canonicalSchemaTablesForRole(role: string = "shared"): readonly string[] {
  if (!DATABASE_ROLES.includes(role as DatabaseRole)) throw new Error(`unknown database role: ${role}`);
  return [...new Set([...schemaTablesForRole(role), ...LEGACY_WORKER_TABLES])];
}

/** Validates a role without duplicating the migration-owned schema. */
export function applyRoleSchema(_db: Database.Database, role: string = "shared"): void {
  canonicalSchemaTablesForRole(role);
}
