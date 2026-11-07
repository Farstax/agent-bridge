/**
 * Short, generic idle-only maintenance admission for one Bridge SQLite role.
 *
 * A BEGIN IMMEDIATE check and install are one serialization point with existing
 * Run/queue SQL writes. Database triggers also guard older processes that do
 * not yet know about this API. The fence remains until an exact-token release
 * or proof-based orphan recovery; its lifetime is NOT a wall-clock lease.
 *
 * Multi-role acquisition fences every existing role before service containment;
 * if any role is busy or unknown, it releases only its own partial fences.
 * This is a serial acquisition protocol, not an assertion that SQLite can
 * atomically commit transactions spanning independent database connections.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readProcessStartTicks } from "./cliSupervisor.js";

export const IDLE_UPGRADE_FENCE_KEY = "agent-bridge:idle-maintenance:v1";
export type IdleUpgradeState = "idle" | "deferred_busy" | "unknown";
export interface IdleUpgradeFence {
  version: 1;
  token: string;
  pid: number;
  startTicks: string;
  /** Distinguishes the same PID/ticks after a machine restart. */
  bootId: string;
  acquiredAt: string;
}
export type IdleUpgradeAdmission =
  | { state: "admitted"; fence: IdleUpgradeFence }
  | { state: IdleUpgradeState };

function currentBootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
    return /^[0-9a-f-]{36}$/.test(value) ? value : null;
  } catch { return null; }
}

const TRIGGER_PREFIX = "ab_idle_maintenance_";
/**
 * These persisted triggers cover both updated and pre-upgrade Bridge processes.
 * A trigger installation is part of the same IMMEDIATE transaction as the
 * idle check and fence marker, not an asynchronous observation followed by a
 * vulnerable second write.
 */
const GATED_TABLES = [
  ["lock", "execution_locks", "INSERT", ""],
  ["run", "bridge_runs", "INSERT", ""],
  ["message", "pending_messages", "INSERT", ""],
  ["claim", "pending_messages", "UPDATE", "NEW.state = 'claimed'"],
  ["receipt", "event_receipts", "INSERT", ""],
  ["receipt_claim", "event_receipts", "UPDATE", "NEW.status IN ('dispatching', 'run_created')"],
  ["capacity", "execution_capacity_claims", "INSERT", ""],
  ["continuation", "settings", "INSERT", "NEW.key LIKE 'run-continuation:v1:%' OR NEW.key LIKE 'outward-queue-reservation:%'"],
  ["continuation_update", "settings", "UPDATE", "NEW.key LIKE 'run-continuation:v1:%' OR NEW.key LIKE 'outward-queue-reservation:%'"],
] as const;

const ACTIVE_QUERIES = [
  "SELECT 1 FROM bridge_runs WHERE status = 'running' LIMIT 1",
  "SELECT 1 FROM execution_locks LIMIT 1",
  "SELECT 1 FROM pending_messages LIMIT 1",
  "SELECT 1 FROM execution_capacity_claims LIMIT 1",
  "SELECT 1 FROM settings WHERE key LIKE 'outward-queue-reservation:%' LIMIT 1",
  // Ambiguous is already a terminal receipt state, not an active dispatch.
  "SELECT 1 FROM event_receipts WHERE status IN ('received', 'dispatching', 'run_created') LIMIT 1",
] as const;

function openExisting(path: string, readonly: boolean): Database.Database {
  if (!path || path === ":memory:") throw new Error("a persistent existing Bridge database is required");
  const db = new Database(path, { readonly, fileMustExist: true, timeout: 2_000 });
  db.pragma("foreign_keys = ON");
  return db;
}

function parseFence(value: string | null): IdleUpgradeFence | null {
  if (!value) return null;
  try {
    const item: unknown = JSON.parse(value);
    if (!item || typeof item !== "object") return null;
    const record = item as Partial<IdleUpgradeFence>;
    return record.version === 1 && typeof record.token === "string"
      && /^[0-9a-f-]{36}$/.test(record.token)
      && Number.isSafeInteger(record.pid) && record.pid! > 0
      && typeof record.startTicks === "string" && /^\d+$/.test(record.startTicks)
      && typeof record.bootId === "string" && /^[0-9a-f-]{36}$/.test(record.bootId)
      && typeof record.acquiredAt === "string" && Number.isFinite(Date.parse(record.acquiredAt))
      ? record as IdleUpgradeFence : null;
  } catch { return null; }
}

function storedFence(db: Database.Database): { exists: boolean; fence: IdleUpgradeFence | null } {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?")
    .get(IDLE_UPGRADE_FENCE_KEY) as { value: string | null } | undefined;
  return { exists: !!row, fence: parseFence(row?.value ?? null) };
}

function idleState(db: Database.Database): IdleUpgradeState {
  const marker = storedFence(db);
  if (marker.exists) return marker.fence ? "deferred_busy" : "unknown";
  for (const sql of ACTIVE_QUERIES) if (db.prepare(sql).get()) return "deferred_busy";
  const continuationRows = db.prepare(
    "SELECT value FROM settings WHERE key LIKE 'run-continuation:v1:%'",
  ).all() as Array<{ value: string | null }>;
  for (const { value } of continuationRows) {
    try {
      if (!value) return "unknown";
      const continuation: unknown = JSON.parse(value);
      if (!continuation || typeof continuation !== "object") return "unknown";
      const state = (continuation as { state?: unknown }).state;
      if (state === "pending" || state === "claimed") return "deferred_busy";
      if (!["completed", "failed", "expired", "cancelled"].includes(String(state))) return "unknown";
    } catch { return "unknown"; }
  }
  return "idle";
}

function installGuard(db: Database.Database): void {
  for (const [name, table, event, predicate] of GATED_TABLES) {
    const condition = predicate ? `(${predicate}) AND ` : "";
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${TRIGGER_PREFIX}${name}
      BEFORE ${event} ON ${table}
      WHEN ${condition}EXISTS(SELECT 1 FROM settings WHERE key = '${IDLE_UPGRADE_FENCE_KEY}')
      BEGIN SELECT RAISE(ABORT, 'agent_bridge_idle_maintenance_deferred_busy'); END`);
  }
}

function uninstallGuard(db: Database.Database): void {
  for (const [name] of GATED_TABLES) db.exec(`DROP TRIGGER IF EXISTS ${TRIGGER_PREFIX}${name}`);
}

function withImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** Read-only, fail-closed status; does not create a database or migrate schema. */
export function readIdleUpgradeState(dbPath: string): IdleUpgradeState {
  let db: Database.Database | undefined;
  try {
    db = openExisting(dbPath, true);
    return idleState(db);
  } catch {
    return "unknown";
  } finally { db?.close(); }
}

/** Atomically install one durable owner fence, or return a retryable busy state. */
export function tryAdmitIdleUpgrade(dbPath: string, ownerPid = process.pid): IdleUpgradeAdmission {
  let db: Database.Database | undefined;
  try {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return { state: "unknown" };
    const startTicks = readProcessStartTicks(ownerPid);
    const bootId = currentBootId();
    if (!startTicks || !bootId) return { state: "unknown" };
    db = openExisting(dbPath, false);
    return withImmediate(db, () => {
      const state = idleState(db!);
      if (state !== "idle") return { state };
      const fence: IdleUpgradeFence = {
        version: 1, token: randomUUID(), pid: ownerPid,
        startTicks, bootId, acquiredAt: new Date().toISOString(),
      };
      installGuard(db!);
      db!.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
        .run(IDLE_UPGRADE_FENCE_KEY, JSON.stringify(fence));
      return { state: "admitted" as const, fence };
    });
  } catch { return { state: "unknown" }; }
  finally { db?.close(); }
}

/** Exact owner token is required, including for rollback and pre-stop failure. */
export function releaseIdleUpgrade(dbPath: string, token: string): boolean {
  const db = openExisting(dbPath, false);
  try {
    return withImmediate(db, () => {
      const record = storedFence(db);
      if (!record.fence || record.fence.token !== token) return false;
      db.prepare("DELETE FROM settings WHERE key = ?").run(IDLE_UPGRADE_FENCE_KEY);
      uninstallGuard(db);
      return true;
    });
  } finally { db.close(); }
}


/**
 * An upgrade owner must fence the entire known database cohort before it may
 * contain any service. There is no "idle" success for an empty/duplicate role
 * list or for missing or unreadable databases. Each BEGIN IMMEDIATE blocks
 * concurrent writes in that role; a Run winning in any not-yet-fenced role
 * forces deferral and exact-token rollback of previously acquired roles.
 */
export interface IdleUpgradeRoleFence {
  dbPath: string;
  fence: IdleUpgradeFence;
}
export type IdleUpgradeRolesAdmission =
  | { state: "admitted"; roles: IdleUpgradeRoleFence[] }
  | { state: IdleUpgradeState };

function distinctRolePaths(dbPaths: readonly string[]): string[] {
  if (dbPaths.length === 0) throw new Error("at least one database role is required");
  const paths = dbPaths.map((path) => realpathSync(path));
  if (new Set(paths).size !== paths.length) throw new Error("duplicate database role");
  return paths.sort();
}

export function readIdleUpgradeRolesState(dbPaths: readonly string[]): IdleUpgradeState {
  try {
    const states = distinctRolePaths(dbPaths).map(readIdleUpgradeState);
    if (states.includes("unknown")) return "unknown";
    return states.includes("deferred_busy") ? "deferred_busy" : "idle";
  } catch { return "unknown"; }
}

/** All-or-none admission. On failed partial release, return unknown (fail closed). */
export function tryAdmitIdleUpgradeRoles(dbPaths: readonly string[], ownerPid = process.pid): IdleUpgradeRolesAdmission {
  const owned: IdleUpgradeRoleFence[] = [];
  let state: IdleUpgradeState = "unknown";
  try {
    const paths = distinctRolePaths(dbPaths);
    for (const dbPath of paths) {
      const result = tryAdmitIdleUpgrade(dbPath, ownerPid);
      if (result.state !== "admitted") {
        state = result.state;
        break;
      }
      owned.push({ dbPath, fence: result.fence });
    }
    if (owned.length === paths.length) {
      // A dead/reused maintenance owner cannot receive a fresh all-roles fence.
      const ticks = readProcessStartTicks(ownerPid);
      const bootId = currentBootId();
      if (ticks && bootId && owned.every((entry) =>
        entry.fence.startTicks === ticks && entry.fence.bootId === bootId)) {
        return { state: "admitted", roles: owned };
      }
    }
  } catch { state = "unknown"; }
  if (owned.length === 0) return { state };
  try {
    if (!releaseIdleUpgradeRoles(owned)) return { state: "unknown" };
  } catch { return { state: "unknown" }; }
  return { state };
}

/** Token-bound release after activation, rollback or an aborted pre-stop attempt. */
export function releaseIdleUpgradeRoles(roles: readonly IdleUpgradeRoleFence[]): boolean {
  if (roles.length === 0) return false;
  let allReleased = true;
  for (const { dbPath, fence } of roles) {
    try { if (!releaseIdleUpgrade(dbPath, fence.token)) allReleased = false; }
    catch { allReleased = false; }
  }
  return allReleased;
}

/**
 * A process death alone is insufficient: an interrupted release can have
 * contained services. The caller must independently prove that the release
 * transaction/containment is finished before requesting orphan recovery.
 */
export function recoverIdleUpgrade(dbPath: string, containmentEnded: (fence: IdleUpgradeFence) => boolean): boolean {
  const db = openExisting(dbPath, false);
  try {
    return withImmediate(db, () => {
      const record = storedFence(db);
      if (!record.fence) return false; // malformed owner stays unknown/fenced
      const fence = record.fence;
      const bootId = currentBootId();
      if (!bootId) return false;
      // PID/start-ticks can be recycled after a reboot. An old boot owner
      // is conclusively dead; clearing still requires containment proof.
      if (bootId === fence.bootId) {
        const ticks = readProcessStartTicks(fence.pid);
        if (ticks === fence.startTicks) return false;
        if (ticks === null) {
          // An unreadable /proc record is not proof of death. ESRCH is; EPERM
          // or a transient /proc read remains ambiguous and fenced.
          try { process.kill(fence.pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        }
      }
      if (!containmentEnded(fence)) return false;
      db.prepare("DELETE FROM settings WHERE key = ?").run(IDLE_UPGRADE_FENCE_KEY);
      uninstallGuard(db);
      return true;
    });
  } finally { db.close(); }
}


/**
 * A trusted release owner may recover an abandoned cohort only after checking
 * its own service-containment transaction. Every DB is checked against the
 * original kernel process instance, never a wall-clock timeout. Unknown or
 * still-owned roles remain fenced and the aggregate result stays false.
 */
export function recoverIdleUpgradeRoles(
  dbPaths: readonly string[],
  containmentEnded: (dbPath: string, fence: IdleUpgradeFence) => boolean,
): boolean {
  let paths: string[];
  try { paths = distinctRolePaths(dbPaths); } catch { return false; }
  let fullyRecovered = true;
  for (const dbPath of paths) {
    try {
      const db = openExisting(dbPath, true);
      let record: { exists: boolean; fence: IdleUpgradeFence | null };
      try { record = storedFence(db); } finally { db.close(); }
      if (!record.exists) continue;
      if (!record.fence || !recoverIdleUpgrade(dbPath, (fence) => containmentEnded(dbPath, fence))) fullyRecovered = false;
    } catch { fullyRecovered = false; }
  }
  return fullyRecovered;
}
