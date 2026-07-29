/**
 * PURPOSE: Fail-closed executable boundary for guarded rollout database tooling.
 * INPUTS: rollout-db CLI arguments plus explicitly gated non-production UAT hooks.
 * OUTPUTS: Uses a simple containment-first inspect/reconcile path for production deploys; delegates all other modes.
 * NEIGHBORS: scripts/rollout-agent-bridge.sh, scripts/rollout-db-impl.ts
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

const TEST_ROOT_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_ROOT";
const BARRIER_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_BARRIER_FILE";
const PAUSE_ENV = "AGENT_BRIDGE_ROLLOUT_TEST_MIGRATE_PAUSE_AFTER_INDEX";
const DEPLOYER_MODE_ENV = "AGENT_BRIDGE_DEPLOYER_MODE";

const testRoot = process.env[TEST_ROOT_ENV];
const barrierFile = process.env[BARRIER_ENV];
const pauseAfterIndex = process.env[PAUSE_ENV];

function fail(message: string): never {
  throw new Error(message);
}

if (!testRoot) {
  delete process.env[BARRIER_ENV];
  delete process.env[PAUSE_ENV];
} else {
  if (typeof process.getuid !== "function" || process.getuid() === 0) {
    fail("rollout migration test hooks are forbidden when running as root");
  }
  if (!isAbsolute(testRoot) || realpathSync(testRoot) !== testRoot) {
    fail(`${TEST_ROOT_ENV} must be an existing canonical absolute directory`);
  }
  if (barrierFile) {
    if (!isAbsolute(barrierFile)) {
      fail(`migration barrier file must be an absolute path inside ${TEST_ROOT_ENV}`);
    }
    const canonicalParent = realpathSync(dirname(barrierFile));
    const relativeParent = relative(testRoot, canonicalParent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
      fail(`migration barrier file must remain inside ${TEST_ROOT_ENV}`);
    }
    if (join(canonicalParent, basename(barrierFile)) !== barrierFile) {
      fail("migration barrier file must be canonical");
    }
  }
  if (pauseAfterIndex !== undefined) {
    const parsed = Number(pauseAfterIndex);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      fail("migration pause index must be a positive integer");
    }
    if (!barrierFile) fail("migration pause index requires a barrier file");
  }
}

type SimpleMode = "inspect" | "reconcile";

interface SimpleOptions {
  mode: SimpleMode;
  databases: string[];
  evidencePath: string | null;
  reason: string;
}

interface BasicEvidence {
  path: string;
  integrity: string;
  foreignKeyViolations: number;
  schemaVersion: number;
  schema: "current" | "legacy" | "future";
  pendingMessageCount: number;
  claimedMessageCount: number;
  runningRunCount: number;
  executionLockCount: number;
  reconciliation?: {
    reason: string;
    runsInterrupted: number;
    locksReleased: number;
    claimsRequeued: number;
    auditId: string | null;
  };
}

function parseSimpleArgs(argv: string[]): SimpleOptions {
  const mode = argv.shift();
  if (mode !== "inspect" && mode !== "reconcile") fail("unsupported containment-first mode");
  const databases: string[] = [];
  let evidencePath: string | null = null;
  let reason = "interrupted_by_controlled_rollout";
  while (argv.length > 0) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value) fail(`missing value for ${flag}`);
    if (flag === "--db") databases.push(value);
    else if (flag === "--evidence") evidencePath = value;
    else if (flag === "--reason") reason = value;
    else if (flag === "--resolving-unit") continue;
    else fail(`unknown argument: ${flag}`);
  }
  if (databases.length === 0) fail("at least one --db path is required");
  if (!reason.trim()) fail("reconciliation reason is required");
  return { mode, databases, evidencePath, reason };
}

function tableNames(db: Database.Database): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name));
}

function count(db: Database.Database, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function inspectBasic(path: string): BasicEvidence {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(db.pragma("integrity_check", { simple: true }));
    const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[]).length;
    const schemaVersion = Number(db.pragma("user_version", { simple: true }));
    const tables = tableNames(db);
    const pendingColumns = tables.has("pending_messages") ? columns(db, "pending_messages") : new Set<string>();
    return {
      path,
      integrity,
      foreignKeyViolations,
      schemaVersion,
      schema: schemaVersion === CURRENT_SCHEMA_VERSION ? "current" : schemaVersion > CURRENT_SCHEMA_VERSION ? "future" : "legacy",
      pendingMessageCount: tables.has("pending_messages") ? count(db, "SELECT COUNT(*) AS count FROM pending_messages") : 0,
      claimedMessageCount: tables.has("pending_messages") && pendingColumns.has("state")
        ? count(db, "SELECT COUNT(*) AS count FROM pending_messages WHERE state = 'claimed' OR claim_run_id IS NOT NULL OR claim_acquisition_id IS NOT NULL")
        : 0,
      runningRunCount: tables.has("bridge_runs") && columns(db, "bridge_runs").has("status")
        ? count(db, "SELECT COUNT(*) AS count FROM bridge_runs WHERE status = 'running'")
        : 0,
      executionLockCount: tables.has("execution_locks") ? count(db, "SELECT COUNT(*) AS count FROM execution_locks") : 0,
    };
  } finally {
    db.close();
  }
}

function reconcileContained(path: string, reason: string): BasicEvidence {
  const db = new Database(path, { fileMustExist: true });
  db.pragma("foreign_keys = ON");
  let result!: BasicEvidence["reconciliation"];
  try {
    const transaction = db.transaction(() => {
      const tables = tableNames(db);
      const now = new Date().toISOString();
      let claimsRequeued = 0;
      let locksReleased = 0;
      let runsInterrupted = 0;

      if (tables.has("pending_messages")) {
        const pending = columns(db, "pending_messages");
        if (["state", "claim_run_id", "claim_acquisition_id", "claimed_at"].every((name) => pending.has(name))) {
          claimsRequeued = db.prepare(`
            UPDATE pending_messages
            SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
            WHERE state = 'claimed' OR claim_run_id IS NOT NULL OR claim_acquisition_id IS NOT NULL
          `).run().changes;
        }
      }

      if (tables.has("execution_locks")) {
        locksReleased = db.prepare("DELETE FROM execution_locks").run().changes;
      }

      if (tables.has("bridge_runs")) {
        const runColumns = columns(db, "bridge_runs");
        if (runColumns.has("status")) {
          const assignments = ["status = 'failed'"];
          const parameters: string[] = [];
          if (runColumns.has("ended_at")) {
            assignments.push("ended_at = COALESCE(ended_at, ?)");
            parameters.push(now);
          }
          if (runColumns.has("error")) {
            assignments.push("error = ?");
            parameters.push(reason);
          }
          runsInterrupted = db.prepare(`UPDATE bridge_runs SET ${assignments.join(", ")} WHERE status = 'running'`).run(...parameters).changes;
        }
      }

      let auditId: string | null = null;
      if (tables.has("reconciliation_audit")) {
        const auditColumns = columns(db, "reconciliation_audit");
        const required = ["id", "kind", "subject_id", "status", "reason", "before_json", "after_json", "created_at", "completed_at"];
        if (required.every((name) => auditColumns.has(name))) {
          auditId = randomUUID();
          const summary = { runsInterrupted, locksReleased, claimsRequeued };
          db.prepare(`
            INSERT INTO reconciliation_audit
              (id, kind, subject_id, status, reason, before_json, after_json, created_at, completed_at)
            VALUES (?, 'rollout', ?, 'completed', ?, ?, ?, ?, ?)
          `).run(auditId, path, reason, JSON.stringify(summary), JSON.stringify(summary), now, now);
        }
      }

      return { reason, runsInterrupted, locksReleased, claimsRequeued, auditId };
    });
    result = transaction();
  } finally {
    db.close();
  }
  const evidence = inspectBasic(path);
  evidence.reconciliation = result;
  return evidence;
}

function writeEvidence(path: string | null, mode: SimpleMode, databases: BasicEvidence[]): void {
  if (!path) return;
  const content = `${JSON.stringify({ mode, createdAt: new Date().toISOString(), databases }, null, 2)}\n`;
  if (path === "-") process.stdout.write(content);
  else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }
}

async function runContainmentFirst(argv: string[]): Promise<void> {
  const options = parseSimpleArgs(argv);
  const evidence = options.mode === "inspect"
    ? options.databases.map(inspectBasic)
    : options.databases.map((path) => reconcileContained(path, options.reason));
  if (evidence.some((entry) => entry.integrity !== "ok" || entry.foreignKeyViolations !== 0 || entry.schema === "future")) {
    fail("database health validation failed");
  }
  writeEvidence(options.evidencePath, options.mode, evidence);
}

const requestedMode = process.argv[2];
if (process.env[DEPLOYER_MODE_ENV] === "1" && (requestedMode === "inspect" || requestedMode === "reconcile")) {
  await runContainmentFirst(process.argv.slice(2));
} else {
  await import("./rollout-db-impl.js");
}
