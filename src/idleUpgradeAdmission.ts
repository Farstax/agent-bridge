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
import { parseRunContinuation, OUTWARD_RUN_ACCEPTED_TURN_PREFIX } from "./runContinuation.js";
import { ConversationRepository } from "./repositories/conversationRepository.js";

export const IDLE_UPGRADE_FENCE_KEY = "agent-bridge:idle-maintenance:v1";
export type IdleUpgradeState = "idle" | "deferred_busy" | "unknown";
export type IdleUpgradeDeferralReason =
  | "existing_fence" | "capacity_claim" | "outward_reservation"
  | "event_dispatch" | "claimed_continuation" | "unknown";
/**
 * `interruptActive` admits a protected release that will interrupt in-process
 * Runs: the durable fence and triggers still stop every NEW Run/claim, but
 * existing running-Run, lock, claimed-message and claimed-wake rows no longer
 * defer it (the controlled-rollout reconciliation resolves them after writer
 * containment). Transient capacity/reservation/dispatch states still defer.
 */
export interface IdleUpgradeAdmissionOptions { interruptActive?: boolean }
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
  | { state: IdleUpgradeState; reason?: IdleUpgradeDeferralReason };

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

// Active work the controlled-rollout reconciliation (db.reconcileControlledRollout)
// explicitly handles after writers are contained: running Runs, execution locks
// and claimed queue messages. An interruptible release does not defer to these.
const INTERRUPTIBLE_QUERIES = [
  "SELECT 1 FROM bridge_runs WHERE status = 'running' LIMIT 1",
  "SELECT 1 FROM execution_locks LIMIT 1",
  "SELECT 1 FROM pending_messages WHERE state <> 'queued' LIMIT 1",
] as const;

// Short transient dispatch/capacity states with no controlled-rollout
// reconciliation: even an interruptible release defers (retryably) on these.
const TRANSIENT_QUERIES = [
  // Durable queued messages are retained across the release transaction. The
  // fence's UPDATE trigger prevents a queued message becoming claimed after
  // admission, and the INSERT trigger prevents fresh submissions.
  // An expired claim is relinquished under the existing lease contract;
  // the capacity owner deletes it on its next acquisition.
  "SELECT 1 FROM execution_capacity_claims WHERE lease_expires_at IS NULL OR lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at) != lease_expires_at LIMIT 1",
  "SELECT 1 FROM settings WHERE key LIKE 'outward-queue-reservation:%' LIMIT 1",
  // Ambiguous is already a terminal receipt state, not an active dispatch.
  // A received receipt is persisted but not dispatching. The update trigger
  // forbids dispatching/run_created while the maintenance fence is held.
  "SELECT 1 FROM event_receipts WHERE status IN ('dispatching', 'run_created') LIMIT 1",
] as const;
const ACTIVE_QUERIES = [...INTERRUPTIBLE_QUERIES, ...TRANSIENT_QUERIES] as const;

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

/**
 * Capture only unambiguous, already accepted ordinary ACP objectives inside
 * the same IMMEDIATE admission transaction, BEFORE the fence marker exists.
 * Reuse any existing agent-requested continuation; never invent a second wake.
 * No background owner, timer, database table, or mutating prompt replay.
 */
function armInterruptedWorkstreamRecovery(db: Database.Database, nowMs: number): void {
  const hasSessions = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outward_acp_sessions'").get();
  if (!hasSessions) return;
  const runs = db.prepare(`
    SELECT r.run_id AS runId, r.chat_id AS chatKey, r.bot AS provider, s.session_id AS sessionId
    FROM bridge_runs r JOIN outward_acp_sessions s ON s.conversation_id = r.chat_id
    WHERE r.status = 'running' AND r.outcome_status IS NULL
      AND r.surface_identity = 'acp:outward' AND s.archived_at IS NULL
  `).all() as Array<{ runId: string; chatKey: string; provider: string; sessionId: string }>;
  const conversations = new ConversationRepository(db);
  const successors = new Set<string>();
  for (const row of db.prepare("SELECT value FROM settings WHERE key LIKE 'run-continuation:v1:%'")
    .all() as Array<{ value: string }>) {
    try {
      const id = (JSON.parse(row.value) as { successorRunId?: unknown }).successorRunId;
      if (typeof id === "string" && id.length > 0) successors.add(id);
    } catch { /* Corrupt records do not authorise a successor. */ }
  }
  for (const run of runs) {
    if (successors.has(run.runId) || !run.sessionId) continue;
    if (db.prepare("SELECT 1 FROM settings WHERE key IN (?, ?) LIMIT 1")
      .get(`outward-stop-fence:${run.chatKey}`, `outward-cancel:${run.runId}`)) continue;
    const key = `run-continuation:v1:${run.runId}`;
    // Existing scheduled work must retain its original terms when a rollout
    // is deferred or aborted. The post-rollout claimant may upgrade it to a
    // recovery wake only after a completed containment audit is proven.
    if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(key)) continue;
    const turnLink = db.prepare("SELECT value FROM settings WHERE key = ?")
      .get(OUTWARD_RUN_ACCEPTED_TURN_PREFIX + run.runId) as { value: string } | undefined;
    if (!turnLink || !/^[1-9][0-9]*$/.test(turnLink.value)) continue;
    const turnId = Number(turnLink.value);
    if (!Number.isSafeInteger(turnId)) continue;
    const turn = conversations.getAcceptedOutwardTurn(run.chatKey, run.provider, turnId);
    if (!turn || /^\/(?:stop|cancel|reset)(?:\s|$)/i.test(turn.text)) continue;
    const continuation = {
      version: 1, id: run.runId, originRunId: run.runId,
      surfaceIdentity: "acp:outward", chatKey: run.chatKey,
      provider: run.provider, reason: "Inspect accepted Workstream objective and finish only uncompleted work",
      requestedAt: new Date(nowMs).toISOString(),
      dueAt: new Date(nowMs + 10_000).toISOString(),
      expiresAt: new Date(nowMs + 2 * 60 * 60_000).toISOString(),
      state: "pending", depth: 1, outwardSessionId: run.sessionId,
      rolloutRecoveryOnly: true, recoveryOriginalTurnId: turn.id,
    };
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(continuation));
  }
}

function idleState(db: Database.Database, options: IdleUpgradeAdmissionOptions = {}): IdleUpgradeState {
  const marker = storedFence(db);
  if (marker.exists) return marker.fence ? "deferred_busy" : "unknown";
  for (const sql of options.interruptActive ? TRANSIENT_QUERIES : ACTIVE_QUERIES) if (db.prepare(sql).get()) return "deferred_busy";
  const continuationRows = db.prepare(
    "SELECT value FROM settings WHERE key LIKE 'run-continuation:v1:%'",
  ).all() as Array<{ value: string | null }>;
  for (const { value } of continuationRows) {
    try {
      if (!value) return "unknown";
      const continuation: unknown = JSON.parse(value);
      if (!continuation || typeof continuation !== "object") return "unknown";
      const state = (continuation as { state?: unknown }).state;
      // A pending wake is dormant durable work, like a queued message. The
      // atomic fence below prevents it being claimed or starting during rollout.
      if (state === "pending") {
        // Only a valid dormant record can be exempted from upgrade admission.
        if (!parseRunContinuation(value)) return "unknown";
        continue;
      }
      if (state === "claimed") { if (options.interruptActive) continue; return "deferred_busy"; }
      if (!["completed", "failed", "expired", "cancelled"].includes(String(state))) return "unknown";
    } catch { return "unknown"; }
  }
  return "idle";
}

/** Read-only, non-sensitive explanation; never changes admission authority. */
function interruptibleDeferralReason(db: Database.Database): IdleUpgradeDeferralReason {
  const marker = storedFence(db);
  if (marker.exists) return marker.fence ? "existing_fence" : "unknown";
  const reasons = ["capacity_claim", "outward_reservation", "event_dispatch"] as const;
  for (let i = 0; i < TRANSIENT_QUERIES.length; i++) {
    if (db.prepare(TRANSIENT_QUERIES[i]).get()) return reasons[i];
  }
  return "unknown";
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
export function tryAdmitIdleUpgrade(dbPath: string, ownerPid = process.pid, options: IdleUpgradeAdmissionOptions = {}): IdleUpgradeAdmission {
  let db: Database.Database | undefined;
  try {
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return { state: "unknown" };
    const startTicks = readProcessStartTicks(ownerPid);
    const bootId = currentBootId();
    if (!startTicks || !bootId) return { state: "unknown" };
    db = openExisting(dbPath, false);
    return withImmediate(db, () => {
      const state = idleState(db!, options);
      if (state !== "idle") return options.interruptActive && state === "deferred_busy"
        ? { state, reason: interruptibleDeferralReason(db!) }
        : { state };
      const fence: IdleUpgradeFence = {
        version: 1, token: randomUUID(), pid: ownerPid,
        startTicks, bootId, acquiredAt: new Date().toISOString(),
      };
      installGuard(db!);
      if (options.interruptActive) armInterruptedWorkstreamRecovery(db!, Date.now());
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
  | { state: IdleUpgradeState; reason?: IdleUpgradeDeferralReason };

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
export function tryAdmitIdleUpgradeRoles(dbPaths: readonly string[], ownerPid = process.pid, options: IdleUpgradeAdmissionOptions = {}): IdleUpgradeRolesAdmission {
  const owned: IdleUpgradeRoleFence[] = [];
  let state: IdleUpgradeState = "unknown";
  let reason: IdleUpgradeDeferralReason | undefined;
  try {
    const paths = distinctRolePaths(dbPaths);
    for (const dbPath of paths) {
      const result = tryAdmitIdleUpgrade(dbPath, ownerPid, options);
      if (result.state !== "admitted") {
        state = result.state;
        reason = result.reason;
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
  if (owned.length === 0) return reason ? { state, reason } : { state };
  try {
    if (!releaseIdleUpgradeRoles(owned)) return { state: "unknown" };
  } catch { return { state: "unknown" }; }
  return reason ? { state, reason } : { state };
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

  // Preflight the entire cohort before changing a single marker. A live owner
  // or unproved containment in one role must not open admission in another.
  const recoverable: IdleUpgradeRoleFence[] = [];
  const bootId = currentBootId();
  if (!bootId) return false;
  for (const dbPath of paths) {
    try {
      const db = openExisting(dbPath, true);
      let record: { exists: boolean; fence: IdleUpgradeFence | null };
      try { record = storedFence(db); } finally { db.close(); }
      if (!record.exists) continue;
      if (!record.fence) return false;
      const { fence } = record;
      if (fence.bootId === bootId) {
        const ticks = readProcessStartTicks(fence.pid);
        if (ticks === fence.startTicks) return false;
        if (ticks === null) {
          try { process.kill(fence.pid, 0); return false; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        }
      }
      if (!containmentEnded(dbPath, fence)) return false;
      recoverable.push({ dbPath, fence });
    } catch { return false; }
  }

  // Each role is re-checked under its IMMEDIATE transaction and by its exact
  // token. An intervening owner cannot be released by this recovery pass.
  let fullyRecovered = true;
  for (const { dbPath, fence } of recoverable) {
    try {
      if (!recoverIdleUpgrade(dbPath, (current) => current.token === fence.token)) fullyRecovered = false;
    } catch { fullyRecovered = false; }
  }
  return fullyRecovered;
}
