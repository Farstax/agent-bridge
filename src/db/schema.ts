import type Database from "better-sqlite3";
import { applyLegacyCompatibleBaseline } from "./legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "./dropLegacyPromptOverridesMigration.js";
import { applyRoleAssignmentsMigration } from "./roleAssignmentsMigration.js";
import { applyReconciliationAuditMigration } from "./reconciliationAuditMigration.js";

/** The schema version reached after the complete registered migration plan. */
export const CURRENT_SCHEMA_VERSION = 4;

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(version: number) {
    super(`unsupported database schema version ${version}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

/**
 * Thrown by openProductionDb() (Phase 4C.2, issue #135) when a database is at
 * a valid, migratable version below CURRENT_SCHEMA_VERSION. Distinct from
 * UnsupportedSchemaVersionError (future/negative/non-integer) so operators
 * and logs can tell "you're behind, run the guarded rollout helper" from
 * "you're ahead or corrupt" at a glance.
 */
export class MigrationRequiredError extends Error {
  constructor(version: number) {
    super(
      `database schema version ${version} requires migration to ${CURRENT_SCHEMA_VERSION} via the guarded rollout helper`,
    );
    this.name = "MigrationRequiredError";
  }
}

export interface ForeignKeyViolation {
  table: string;
  rowid: number | bigint | null;
  parent: string;
  fkid: number;
}

export class MigrationForeignKeyViolationError extends Error {
  constructor(public readonly violations: readonly ForeignKeyViolation[]) {
    super(`migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`);
    this.name = "MigrationForeignKeyViolationError";
  }
}

/**
 * Applies migrations transactionally up to an explicit target version. The
 * registered plan must end exactly at targetVersion, and no migration above
 * targetVersion is ever executed. Exported so tests can exercise an
 * intermediate target (e.g. a two-step failure partway through a plan)
 * without weakening the production entry point below.
 */
export function applyMigrationsUpTo(
  db: Database.Database,
  migrations: readonly Migration[],
  targetVersion: number,
): void {
  const current = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(current) || current < 0 || current > targetVersion) {
    throw new UnsupportedSchemaVersionError(current);
  }
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  const expected = ordered.map((migration) => migration.version);
  if (expected.some((version, index) => version !== index + 1)) {
    throw new Error("database migrations must be sequentially numbered from 1");
  }
  const highestRegistered = ordered.length > 0 ? ordered[ordered.length - 1].version : 0;
  if (highestRegistered !== targetVersion) {
    throw new Error(`database migrations must end exactly at target schema version ${targetVersion}`);
  }
  if (current === targetVersion) return;

  // PRAGMA foreign_keys is a documented no-op inside a transaction, so it
  // must be toggled here, before db.transaction() opens its BEGIN, for
  // migrations that rename/recreate tables (e.g. to widen a CHECK
  // constraint) to actually run with enforcement suspended. Restored
  // unconditionally afterward, success or failure.
  const foreignKeysWereEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
  try {
    const migrate = db.transaction(() => {
      for (const migration of ordered) {
        if (migration.version <= current || migration.version > targetVersion) continue;
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      }
      // foreign_key_check runs a full on-demand scan regardless of the
      // foreign_keys enforcement setting, and works inside a transaction
      // (unlike the foreign_keys pragma itself). Restoring foreign_keys = ON
      // afterward does not retroactively detect violations left by a rename
      // /recreate repair, so verify explicitly before this transaction can
      // commit and stamp user_version.
      const violations = db.pragma("foreign_key_check") as ForeignKeyViolation[];
      if (violations.length > 0) throw new MigrationForeignKeyViolationError(violations);
    });
    migrate();
  } finally {
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
}

/**
 * Production entry point: applies the default migration set, always ending
 * exactly at CURRENT_SCHEMA_VERSION. Never accepts an override target, so a
 * migration plan that overshoots or undershoots the declared version fails
 * closed rather than silently advancing past it.
 */
export function applyMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = DEFAULT_MIGRATIONS,
): void {
  applyMigrationsUpTo(db, migrations, CURRENT_SCHEMA_VERSION);
}

/**
 * Version 1 owns the legacy-compatible DDL and historical repair path.
 * Version 2 removes the empty legacy prompt-override table.
 * Version 3 adds dormant, versioned role-assignment persistence.
 * Version 4 adds schema-owned reconciliation evidence for Issue #193.
 * Each step is transactional and user_version remains authoritative.
 */
const DEFAULT_MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
  { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
  { version: 3, name: "add-dormant-role-assignments", up: applyRoleAssignmentsMigration },
  { version: 4, name: "add-reconciliation-audit", up: applyReconciliationAuditMigration },
];
