import type Database from "better-sqlite3";
import { schemaTablesForRole } from "./schema.js";

export const DATABASE_ROLES = ["shared", "discord", "health", "interactive", "worker"] as const;
export type DatabaseRole = (typeof DATABASE_ROLES)[number];

export function canonicalSchemaTablesForRole(role: string = "shared"): readonly string[] {
  if (!DATABASE_ROLES.includes(role as DatabaseRole)) throw new Error(`unknown database role: ${role}`);
  return schemaTablesForRole(role);
}

/** Validates a role without duplicating the migration-owned schema. */
export function applyRoleSchema(_db: Database.Database, role: string = "shared"): void {
  canonicalSchemaTablesForRole(role);
}
