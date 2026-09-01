/**
 * PURPOSE: SQLite database storage interface and migration definitions for Agent Bridge state.
 * INPUTS: Database file paths, chat IDs, bot types, and session tokens.
 * OUTPUTS: Active session IDs, locks, update indices, and model overrides.
 * NEIGHBORS: src/index.ts, src/bridge.ts
 * LOGIC: Executes DDL schema checks, implements migrations for new columns, and exposes parameterized CRUD operations on the SQLite backend.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LockRepository, type ExecutionLaneHandle, type ExecutionLockRecord } from "./repositories/lockRepository.js";
export type { ExecutionLaneHandle } from "./repositories/lockRepository.js";
import { RunRepository, type RunningRun } from "./repositories/runRepository.js";
import { SessionRepository } from "./repositories/sessionRepository.js";
import { SettingsRepository } from "./repositories/settingsRepository.js";
import { EventReceiptRepository } from "./repositories/eventReceiptRepository.js";
import { AdvisorRepository } from "./repositories/advisorRepository.js";

type OrphanProcessState = "live" | "absent" | "ambiguous";
export type ReconciliationContainment = "proven" | "unproven" | "ambiguous";
export type ReconciliationLockState = "absent" | "live" | "stale" | "ambiguous";

export interface OrphanReconciliationOptions {
  nowMs?: number;
  minAgeMs: number;
  processState: (run: RunningRun) => OrphanProcessState;
  candidateRuns?: RunningRun[];
  containmentState?: (run: RunningRun, processState: OrphanProcessState) => ReconciliationContainment;
  beforeMutation?: (run: RunningRun) => void;
  onReconciled?: (run: RunningRun & { ended_at: string }) => void | Promise<void>;
}

class ReconciliationLostRace extends Error {}

export interface StaleLockReconciliationOptions {
  nowMs?: number;
  reason: string;
  candidateLocks?: ExecutionLockRecord[];
  containmentState: (lock: ExecutionLockRecord) => ReconciliationContainment;
  lockState: (lock: ExecutionLockRecord) => Exclude<ReconciliationLockState, "absent">;
}

export interface ControlledRolloutReconciliationOptions {
  nowMs?: number;
  reason: string;
}

import { ConversationRepository, DEFAULT_CONTEXT_MAX_CHARS, type AuthorizedConversationSearchScope, type ConversationTurnProvenance } from "./repositories/conversationRepository.js";
export { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_RECENT_TURN_LIMIT } from "./repositories/conversationRepository.js";
import { applyMigrations, CURRENT_SCHEMA_VERSION, MigrationRequiredError, UnsupportedSchemaVersionError } from "./db/schema.js";
import { assertDatabaseForeignKeyIntegrity } from "./db/roleAssignmentsMigration.js";
import { classifyLifecycleState } from "./rolloutLifecycle.js";
import type { BotKind } from "./types.js";

// Sentinel row keys stored in bridge_state for non-chat state
const pollingKey = (bot: string) => `$polling:${bot}`;

function assertExecutionScope(surface: string, chatKey: string): void {
  if (!surface?.trim()) throw new Error("surface is required");
  if (!chatKey?.trim()) throw new Error("chatKey is required");
}

export interface OpenDbOptions {
  /** Stable across configuration changes and restarts. */
  serviceId?: string;
  /** Unique to one live process generation. */
  runId?: string;
  lockLeaseMs?: number;
  /** Test-only clock injection for deterministic lease expiry. */
  clock?: () => number;
  /** Appliance installation identity expected by production startup. */
  installationId?: string;
  /** Fail closed when the database has no fresh-install provenance. */
  requireInstallationIdentity?: boolean;
  /** Expected provenance role for this service's database. */
  databaseRole?: string;
}

export class ExecutionLockLostError extends Error {
  constructor() { super("execution lock ownership lost"); }
}

/**
 * Thrown by openProductionDb() (Phase 4C.2, issue #135) when the database
 * file does not exist. Unlike openDb(), openProductionDb() never creates a
 * database implicitly — missing-file bootstrap is a distinct, explicitly
 * owned path (the guarded rollout helper's bootstrap mode), not an ordinary
 * startup side effect.
 */
export class DatabaseMissingError extends Error {
  constructor(dbPath: string) {
    super(`production database does not exist: ${dbPath}`);
    this.name = "DatabaseMissingError";
  }
}

/**
 * Shared post-version-check construction tail for openDb() and
 * openProductionDb() (Phase 4C.2, issue #135): WAL/foreign-key pragmas,
 * migration application, non-schema runtime maintenance, and BridgeDb
 * construction. Both callers have already validated dbPath/schemaVersion
 * before reaching here, so this never needs to reject or close raw itself.
 */
function finishOpen(raw: Database.Database, options: OpenDbOptions): BridgeDb {
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  applyMigrations(raw, undefined, options.databaseRole);

  // Retained conversation turns are source evidence. Historical summary,
  // compaction-attempt, and project-memory tables remain in the schema so #544
  // does not perform a destructive migration, but startup does not read,
  // regenerate, or prune through those retired execution paths.

  // Expire sessions older than 7 days — prevents a stale/corrupt session from
  // being resumed indefinitely after a long gap without a /reset
  for (const bot of ["codex", "antigravity", "claude", "grok", "cursor"] as const) {
    raw.exec(
      `UPDATE bridge_state
       SET ${bot}_session_id = NULL, ${bot}_session_created_at = NULL
       WHERE ${bot}_session_created_at IS NOT NULL
         AND ${bot}_session_created_at < datetime('now', '-7 days')`
    );
  }
  const leaseMs = options.lockLeaseMs ?? 90_000;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("lockLeaseMs must be greater than zero");
  return new BridgeDb(raw, {
    serviceId: options.serviceId ?? "diagnostic",
    runId: options.runId ?? randomUUID(),
    leaseMs,
    clock: options.clock,
  });
}

function assertProductionInstallation(raw: Database.Database, dbPath: string, options: OpenDbOptions): void {
  if (!options.requireInstallationIdentity && !options.installationId) return;
  const expected = options.installationId?.trim();
  if (!expected) throw new Error("agent bridge installation identity is required");
  const get = (key: string): string | null => {
    const row = raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value?: string | null } | undefined;
    return row?.value ?? null;
  };
  const stored = get("agent_bridge_installation_id");
  if (!stored || stored !== expected) throw new Error("database installation provenance is missing or mismatched");
  const provenanceText = get("agent_bridge_database_provenance");
  if (!provenanceText) throw new Error("database installation provenance is missing");
  let provenance: unknown;
  try { provenance = JSON.parse(provenanceText); } catch { throw new Error("database installation provenance is malformed"); }
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("database installation provenance is malformed");
  }
  const record = provenance as Record<string, unknown>;
  if (record.schemaVersion !== 1 || (record.source !== "fresh-install" && record.source !== "adopted-existing")
    || record.installationId !== expected || record.role !== options.databaseRole || record.path !== dbPath) {
    throw new Error("database installation provenance is invalid");
  }
  if (get("agent_bridge_first_boot_verified")) return;
  const sessionCount = Number((raw.prepare(`SELECT COUNT(*) AS n FROM bridge_state
    WHERE codex_session_id IS NOT NULL OR claude_session_id IS NOT NULL
       OR antigravity_session_id IS NOT NULL OR grok_session_id IS NOT NULL
       OR cursor_session_id IS NOT NULL`).get() as { n: number }).n);
  const runCount = Number((raw.prepare("SELECT COUNT(*) AS n FROM bridge_runs").get() as { n: number }).n);
  if (sessionCount > 0 || runCount > 0) throw new Error("first boot database already contains sessions or runs");
  raw.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run("agent_bridge_first_boot_verified", new Date().toISOString());
}

export function openDb(dbPath: string, options: OpenDbOptions = {}): BridgeDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const raw = new Database(dbPath);
  // Version-gate before WAL mode or any other write-affecting operation, so a
  // future, negative, or otherwise unsupported database is rejected without
  // being mutated. Mirrors the validation in applyMigrationsUpTo() so no
  // invalid version can reach WAL mode via this earlier gate.
  const schemaVersion = Number(raw.pragma("user_version", { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CURRENT_SCHEMA_VERSION) {
    raw.close();
    throw new UnsupportedSchemaVersionError(schemaVersion);
  }
  return finishOpen(raw, options);
}

/**
 * Strict, production-only opener (Phase 4C.2, issue #135). Used only by the
 * five ordinary-startup service entrypoints. Unlike openDb():
 *  - Never creates a missing file — fails closed with DatabaseMissingError.
 *  - Only accepts a database already at exactly CURRENT_SCHEMA_VERSION — a
 *    valid but behind-current (legacy/migratable) version fails closed with
 *    MigrationRequiredError instead of being auto-migrated. Schema migration
 *    on a production database is owned exclusively by the guarded rollout
 *    helper (scripts/rollout-agent-bridge.sh + scripts/rollout-db.ts).
 *  - Future/negative/non-integer versions still fail closed with the
 *    existing UnsupportedSchemaVersionError, exactly as openDb() does today.
 * All checks happen before WAL mode is enabled or any write occurs.
 *
 * The `{ fileMustExist: true }` open itself is the authoritative check —
 * there is deliberately no separate existsSync() pre-check, which would
 * leave a check-then-open race (the file could be deleted between the check
 * and the open). Missing-file translation happens in the open's own failure
 * path instead: existsSync() is consulted only after the open has already
 * failed, purely to classify the failure, not to gate it.
 */
export function openProductionDb(dbPath: string, options: OpenDbOptions = {}): BridgeDb {
  let raw: Database.Database;
  try {
    raw = new Database(dbPath, { fileMustExist: true });
  } catch (err) {
    if (dbPath !== ":memory:" && !existsSync(dbPath)) {
      throw new DatabaseMissingError(dbPath);
    }
    throw err;
  }
  const schemaVersion = Number(raw.pragma("user_version", { simple: true }));
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0 || schemaVersion > CURRENT_SCHEMA_VERSION) {
    raw.close();
    throw new UnsupportedSchemaVersionError(schemaVersion);
  }
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    raw.close();
    throw new MigrationRequiredError(schemaVersion);
  }
  try {
    assertDatabaseForeignKeyIntegrity(raw);
    assertProductionInstallation(raw, dbPath, options);
  } catch (error) {
    raw.close();
    throw error;
  }
  return finishOpen(raw, options);
}

export class BridgeDb {
  readonly raw: Database.Database;
  readonly lockHeartbeatMs: number;
  private readonly sessions: SessionRepository;
  private readonly locks: LockRepository;
  private readonly settings: SettingsRepository;
  private readonly runs: RunRepository;
  private readonly eventReceipts: EventReceiptRepository;
  private readonly advisorCalls: AdvisorRepository;
  private readonly conversations: ConversationRepository;

  constructor(raw: Database.Database, lockOptions: {
    serviceId: string; runId: string; leaseMs: number; clock?: () => number;
  } = { serviceId: "diagnostic", runId: randomUUID(), leaseMs: 90_000 }) {
    this.raw = raw;
    this.sessions = new SessionRepository(raw);
    this.locks = new LockRepository(raw, lockOptions);
    this.lockHeartbeatMs = Math.max(100, Math.floor(lockOptions.leaseMs / 3));
    this.settings = new SettingsRepository(raw);
    this.runs = new RunRepository(raw);
    this.eventReceipts = new EventReceiptRepository(raw);
    this.advisorCalls = new AdvisorRepository(raw);
    this.conversations = new ConversationRepository(raw);
  }

  runInTransaction<T>(operation: () => T): T {
    return this.raw.transaction(operation)();
  }

  runWithLockFence<T>(handle: ExecutionLaneHandle, operation: () => T): T {
    assertExecutionScope(handle.surface, handle.chatKey);
    return this.runInTransaction(() => {
      if (!this.locks.heartbeat(handle)) throw new ExecutionLockLostError();
      return operation();
    });
  }

  // ── Session management ───────────────────────────────────────────────────

  getSession(chatId: string, bot: BotKind): string | null {
    return this.sessions.getSession(chatId, bot);
  }

  setSession(chatId: string, bot: BotKind, sessionId: string | null): void {
    this.sessions.setSession(chatId, bot, sessionId);
  }

  // ── Per-chat execution lock ──────────────────────────────────────────────

  acquireLock(surface: string, chatKey: string): ExecutionLaneHandle | null {
    assertExecutionScope(surface, chatKey);
    return this.locks.acquire(surface, chatKey);
  }

  heartbeatLock(handle: ExecutionLaneHandle): boolean {
    return this.locks.heartbeat(handle);
  }

  ownsLock(handle: ExecutionLaneHandle): boolean {
    return this.locks.owns(handle);
  }

  unlock(handle: ExecutionLaneHandle): boolean {
    return this.locks.unlock(handle);
  }

  // ── Global polling offset (per bot kind) ────────────────────────────────

  getLastUpdateId(bot: BotKind): number {
    return this.settings.getLastUpdateId(bot);
  }

  setLastUpdateId(bot: BotKind, updateId: number): void {
    this.settings.setLastUpdateId(bot, updateId);
  }

  // ── Model-override settings ──────────────────────────────────────────────

  getSetting(key: string): string | null {
    return this.settings.getSetting(key);
  }

  // ── Session failure circuit breaker ─────────────────────────────────────

  incrementFailures(chatId: string, bot: BotKind): number {
    return this.settings.incrementFailures(chatId, bot);
  }

  resetFailures(chatId: string, bot: BotKind): void {
    this.settings.resetFailures(chatId, bot);
  }

  getMaxConsecutiveFailures(): { bot: string; count: number }[] {
    return this.settings.getMaxConsecutiveFailures();
  }

  setSetting(key: string, value: string | null): void {
    this.settings.setSetting(key, value);
  }

  reserveAdvisorCall(input: {
    requestId: string; scopeKey: string; turnKey?: string; taskKey?: string;
    mode: string; trigger: string; contextChars: number;
    maxCallsPerTurn: number; maxCallsPerTask: number;
  }): boolean {
    return this.advisorCalls.reserveAdvisorCall(input);
  }

  addAdvisorAttempt(input: {
    requestId: string; ordinal: number; provider: string; model: string;
    status: string; errorKind?: string; durationMs: number;
  }): void {
    this.advisorCalls.addAdvisorAttempt(input);
  }

  completeAdvisorCall(requestId: string, provider: string, model: string, confidence: string): void {
    this.advisorCalls.completeAdvisorCall(requestId, provider, model, confidence);
  }

  failAdvisorCall(requestId: string, errorKind: string): void {
    this.advisorCalls.failAdvisorCall(requestId, errorKind);
  }

  getAdvisorAttempts(requestId: string): Array<Record<string, unknown>> {
    return this.advisorCalls.getAdvisorAttempts(requestId);
  }

  getChatRepo(chatId: string): string | null {
    return this.settings.getChatRepo(chatId);
  }

  setChatRepo(chatId: string, repo: string | null): void {
    this.settings.setChatRepo(chatId, repo);
  }

  insertRun(
    runId: string,
    chatId: string,
    bot: string,
  ): void {
    this.runs.insertRun(runId, chatId, bot);
  }

  getRun(runId: string): any {
    return this.runs.getRun(runId);
  }

  updateRunCompleted(runId: string, text: string, sessionId: string | null): boolean {
    return this.runs.updateRunCompleted(runId, text, sessionId);
  }

  updateRunFailed(runId: string, error: string): boolean {
    return this.runs.updateRunFailed(runId, error);
  }

  updateRunCancelled(runId: string, reason: string): boolean {
    return this.runs.updateRunCancelled(runId, reason);
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    this.runs.insertEvent(runId, seq, type, timestamp, payload);
  }

  getEventsForRun(runId: string): any[] {
    return this.runs.getEventsForRun(runId);
  }

  // ── Event receipts ───────────────────────────────────────────────────────

  createEventReceipt(input: {
    event_id: string;
    source: string;
    event_kind: string;
    idempotency_key: string;
    received_at: string;
    occurred_at: string;
    payload_json: string;
    authority_scope: string;
  }): EventReceipt {
    return this.eventReceipts.createReceipt(input);
  }

  getEventReceipt(id: number): EventReceipt | null {
    return this.eventReceipts.getById(id);
  }

  getEventReceiptByIdempotencyKey(idempotencyKey: string): EventReceipt | null {
    return this.eventReceipts.getByIdempotencyKey(idempotencyKey);
  }

  listPendingEventReceipts(): EventReceipt[] {
    return this.eventReceipts.listPending();
  }

  linkEventReceiptRun(id: number, runId: string): void {
    this.eventReceipts.linkRun(id, runId);
  }

  recordEventReceiptResult(
    id: number,
    input: { status: "completed" | "failed" | "cancelled"; result_reference: string | null; error_class: string | null },
  ): void {
    this.eventReceipts.recordResult(id, input);
  }

  async reconcileOrphanedRuns(options: OrphanReconciliationOptions): Promise<Array<RunningRun & { ended_at: string }>> {
    if (!Number.isFinite(options.minAgeMs) || options.minAgeMs < 0) {
      throw new Error("minAgeMs must be a finite non-negative number");
    }
    const nowMs = options.nowMs ?? Date.now();
    const reconciled: Array<RunningRun & { ended_at: string }> = [];
    for (const run of options.candidateRuns ?? this.runs.listRunningRuns()) {
      const startedMs = Date.parse(run.started_at);
      if (!Number.isFinite(startedMs) || nowMs - startedMs < options.minAgeMs) continue;
      const processState = options.processState(run);
      const containmentState = options.containmentState?.(run, processState) ?? "ambiguous";
      if (processState !== "absent" || containmentState !== "proven") continue;
      const lockState = this.locks.hasRunLock(run.run_id) || this.locks.hasChatLock(run.chat_id) ? "live" : "absent" as const;
      const claimed = this.raw.prepare(`
        SELECT id, state, claim_run_id, claim_acquisition_id
        FROM pending_messages WHERE claim_run_id = ? ORDER BY id
      `).all(run.run_id) as Array<Record<string, unknown>>;
      if (lockState !== "absent" || claimed.length > 0) continue;
      const endedAt = new Date(nowMs).toISOString();
      const evidence = {
        reason: "stale_after_cutoff",
        errorMessage: "Process interrupted by bridge restart",
        reconciledAt: endedAt,
        processState,
        containmentState,
        lockState,
        claimedMessages: claimed,
        cutoffMs: options.minAgeMs,
      };
      const auditId = randomUUID();
      const before = { status: "running", processState, containmentState, lockState, claimedMessages: claimed };
      let transitioned = false;
      try {
        transitioned = this.runInTransaction(() => {
          this.raw.prepare(`INSERT INTO reconciliation_audit
            (id, kind, subject_id, status, reason, cutoff_ms, before_json, created_at)
            VALUES (?, 'run', ?, 'started', ?, ?, ?, ?)`)
            .run(auditId, run.run_id, evidence.reason, options.minAgeMs, JSON.stringify(before), endedAt);
          options.beforeMutation?.(run);
          const changed = this.runs.reconcileOrphanedRun(run.run_id, endedAt, evidence);
          if (!changed) throw new ReconciliationLostRace();
          const after = { status: "failed", endedAt };
          this.raw.prepare(`UPDATE reconciliation_audit SET status = 'completed', after_json = ?, completed_at = ? WHERE id = ?`)
            .run(JSON.stringify(after), endedAt, auditId);
          return true;
        });
      } catch (error) {
        if (!(error instanceof ReconciliationLostRace)) throw error;
      }
      if (!transitioned) continue;
      const result = { ...run, ended_at: endedAt };
      reconciled.push(result);
      try {
        await options.onReconciled?.(result);
      } catch (error) {
        console.error(`Failed to handle reconciled run ${run.run_id}`, error);
      }
    }
    return reconciled;
  }

  reconcileStaleExecutionLocks(options: StaleLockReconciliationOptions): ExecutionLockRecord[] {
    if (!options.reason.trim()) throw new Error("reconciliation reason is required");
    const now = new Date(options.nowMs ?? Date.now()).toISOString();
    const released: ExecutionLockRecord[] = [];
    for (const lock of options.candidateLocks ?? this.locks.listLocks()) {
      if (options.containmentState(lock) !== "proven" || options.lockState(lock) !== "stale") continue;
      const auditId = randomUUID();
      let changed = false;
      try {
        changed = this.runInTransaction(() => {
          this.raw.prepare(`INSERT INTO reconciliation_audit
            (id, kind, subject_id, status, reason, before_json, created_at)
            VALUES (?, 'lock', ?, 'started', ?, ?, ?)`)
            .run(auditId, `${lock.surface}:${lock.chat_key}`, options.reason, JSON.stringify(lock), now);
          const removed = this.locks.releaseExact(lock);
          if (!removed) throw new ReconciliationLostRace();
          this.raw.prepare(`UPDATE reconciliation_audit SET status = 'completed', after_json = ?, completed_at = ? WHERE id = ?`)
            .run(JSON.stringify({ released: true, releasedAt: now }), now, auditId);
          return true;
        });
      } catch (error) {
        if (!(error instanceof ReconciliationLostRace)) throw error;
      }
      if (changed) released.push(lock);
    }
    return released;
  }

  reconcileControlledRollout(options: ControlledRolloutReconciliationOptions): {
    reconciledRunIds: string[];
    releasedLockCount: number;
    requeuedClaimCount: number;
  } {
    if (!options.reason.trim()) throw new Error("reconciliation reason is required");
    const nowMs = options.nowMs ?? Date.now();
    const now = new Date(nowMs).toISOString();
    const runs = this.runs.listRunningRuns();
    const locks = this.locks.listLocks();
    const claims = this.raw.prepare(`
      SELECT id, surface, chat_key, state, claim_run_id, claim_acquisition_id, claimed_at
      FROM pending_messages
      WHERE state = 'claimed' OR claim_run_id IS NOT NULL OR claim_acquisition_id IS NOT NULL
      ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    const auditIds: string[] = [];
    const reconciledRunIds = this.runInTransaction(() => {
      for (const run of runs) {
        const auditId = randomUUID();
        auditIds.push(auditId);
        this.raw.prepare(`INSERT INTO reconciliation_audit
          (id, kind, subject_id, status, reason, before_json, created_at)
          VALUES (?, 'run', ?, 'started', ?, ?, ?)`)
          .run(auditId, run.run_id, options.reason, JSON.stringify({ status: "running", processState: "absent", containmentState: "proven" }), now);
      }
      for (const lock of locks) {
        const auditId = randomUUID();
        auditIds.push(auditId);
        this.raw.prepare(`INSERT INTO reconciliation_audit
          (id, kind, subject_id, status, reason, before_json, created_at)
          VALUES (?, 'lock', ?, 'started', ?, ?, ?)`)
          .run(auditId, `${lock.surface}:${lock.chat_key}`, options.reason, JSON.stringify(lock), now);
      }
      for (const claim of claims) {
        const auditId = randomUUID();
        auditIds.push(auditId);
        this.raw.prepare(`INSERT INTO reconciliation_audit
          (id, kind, subject_id, status, reason, before_json, created_at)
          VALUES (?, 'claim', ?, 'started', ?, ?, ?)`)
          .run(auditId, String(claim.id), options.reason, JSON.stringify(claim), now);
      }
      for (const run of runs) {
        if (!this.runs.reconcileOrphanedRun(run.run_id, now, {
          reason: options.reason, reconciledAt: now, processState: "absent", lockState: "absent", cutoffMs: 0,
        })) throw new ReconciliationLostRace();
      }
      for (const claim of claims) {
        const changed = this.raw.prepare(`
          UPDATE pending_messages
          SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
          WHERE id = ? AND (state = 'claimed' OR claim_run_id IS NOT NULL OR claim_acquisition_id IS NOT NULL)
        `).run(claim.id).changes;
        if (changed !== 1) throw new ReconciliationLostRace();
      }
      for (const lock of locks) {
        const released = this.raw.prepare(`
          DELETE FROM execution_locks
          WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
        `).run(lock.surface, lock.chat_key, lock.service_id, lock.run_id, lock.acquisition_id).changes;
        if (released !== 1) throw new ReconciliationLostRace();
      }
      for (const auditId of auditIds) {
        this.raw.prepare(`UPDATE reconciliation_audit
          SET status = 'completed', after_json = ?, completed_at = ? WHERE id = ?`)
          .run(JSON.stringify({ reason: options.reason, reconciled: true }), now, auditId);
      }
      return runs.map((run) => run.run_id);
    });
    return { reconciledRunIds, releasedLockCount: locks.length, requeuedClaimCount: claims.length };
  }

  // ── Conversation turns ──────────────────────────────────────────────────

  addConvTurn(chatKey: string, role: "user" | "assistant", text: string, cli?: string, provenance?: ConversationTurnProvenance): void {
    this.conversations.addConvTurn(chatKey, role, text, cli, provenance);
  }

  getRecentConvTurns(
    chatKey: string,
    limit: number,
    sinceId?: number,
    surfaceIdentity?: string,
  ): Array<{ id: number; role: string; text: string; cli: string | null; created_at: string }> {
    return this.conversations.getRecentConvTurns(chatKey, limit, sinceId, surfaceIdentity);
  }

  buildConvContext(chatKey: string, maxChars = DEFAULT_CONTEXT_MAX_CHARS, surfaceIdentity?: string): string {
    return this.conversations.buildConvContext(chatKey, maxChars, surfaceIdentity);
  }

  // ── Pending messages ────────────────────────────────────────────────────

  pendingMsgCount(surface: string, chatKey: string): number {
    assertExecutionScope(surface, chatKey);
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE surface = ? AND chat_key = ?`)
      .get(surface, chatKey) as { n: number };
    return row.n;
  }

  enqueueMsg(
    surface: string,
    chatKey: string,
    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[]; scheduledOccurrenceKey?: string },
  ): void {
    assertExecutionScope(surface, chatKey);
    this.raw
      .prepare(
        `INSERT INTO pending_messages (surface, chat_key, prompt, chat_id, thread_id, chat_type, user_id, attachments_json, scheduled_occurrence_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(surface, chatKey, msg.prompt, msg.chatId, msg.threadId ?? null, msg.chatType, msg.userId ?? null, JSON.stringify(msg.attachments ?? []), msg.scheduledOccurrenceKey ?? null);
  }

  dequeueMsgs(surface: string, chatKey: string): Array<{
    id: number; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;
  }> {
    assertExecutionScope(surface, chatKey);
    return (this.raw
      .prepare(`SELECT id, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
                       attachments_json AS attachmentsJson, scheduled_occurrence_key AS scheduledOccurrenceKey
                FROM pending_messages WHERE surface = ? AND chat_key = ? ORDER BY id ASC`)
      .all(surface, chatKey) as any[]).map(({ attachmentsJson, ...row }) => ({ ...row, attachments: JSON.parse(attachmentsJson || "[]") }));
  }

  deletePendingMsg(id: number): void {
    this.raw.prepare(`DELETE FROM pending_messages WHERE id = ?`).run(id);
  }

  retireQueuedPendingMsgs(surface: string, chatKey: string, ids: number[]): boolean {
    assertExecutionScope(surface, chatKey);
    const mismatch = new Error("queued pending-message ownership changed");
    try {
      return this.runInTransaction(() => {
        const statement = this.raw.prepare(`
          DELETE FROM pending_messages
          WHERE id = ? AND surface = ? AND chat_key = ? AND state = 'queued'
            AND claim_run_id IS NULL AND claim_acquisition_id IS NULL
        `);
        for (const id of ids) {
          if (statement.run(id, surface, chatKey).changes !== 1) throw mismatch;
        }
        return true;
      });
    } catch (error) {
      if (error === mismatch) return false;
      throw error;
    }
  }

  claimNextPendingMsg(handle: ExecutionLaneHandle): {
    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;
  } | null {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.ownsLock(handle)) return null;
      this.raw.prepare(`
        UPDATE pending_messages SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
        WHERE surface = ? AND chat_key = ? AND state = 'claimed' AND (claim_run_id IS NOT ? OR claim_acquisition_id IS NOT ?)
      `).run(surface, chatKey, handle.runId, handle.acquisitionId);
      const active = this.raw.prepare(`
        SELECT 1 FROM pending_messages
        WHERE surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ? LIMIT 1
      `).get(surface, chatKey, handle.runId, handle.acquisitionId);
      if (active) return null;
      const row = this.raw.prepare(`
        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson,
               scheduled_occurrence_key AS scheduledOccurrenceKey
        FROM pending_messages WHERE surface = ? AND chat_key = ? AND state = 'queued' ORDER BY id ASC LIMIT 1
      `).get(surface, chatKey) as any;
      if (!row) return null;
      const changed = this.raw.prepare(`
        UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?, claimed_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(handle.runId, handle.acquisitionId, new Date().toISOString(), row.id).changes;
      if (changed !== 1) return null;
      const { attachmentsJson, state: _state, claimRunId: _claimRunId, claimAcquisitionId: _claimAcquisitionId, ...claimed } = row;
      return { ...claimed, attachments: JSON.parse(attachmentsJson || "[]") };
    });
  }

  claimPendingMsgs(handle: ExecutionLaneHandle): Array<{
    id: number; chatKey: string; prompt: string; chatId: number | string; threadId: number | string | null; chatType: string; userId: number | string | null; attachments: string[]; scheduledOccurrenceKey: string | null;
  }> {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.ownsLock(handle)) return [];
      this.raw.prepare(`
        UPDATE pending_messages SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL
        WHERE surface = ? AND chat_key = ? AND state = 'claimed' AND (claim_run_id IS NOT ? OR claim_acquisition_id IS NOT ?)
      `).run(surface, chatKey, handle.runId, handle.acquisitionId);
      const rows = this.raw.prepare(`
        SELECT id, chat_key AS chatKey, prompt, chat_id AS chatId, thread_id AS threadId, chat_type AS chatType, user_id AS userId,
               state, claim_run_id AS claimRunId, claim_acquisition_id AS claimAcquisitionId, attachments_json AS attachmentsJson,
               scheduled_occurrence_key AS scheduledOccurrenceKey
        FROM pending_messages
        WHERE surface = ? AND chat_key = ?
          AND (state = 'queued' OR (state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ?))
        ORDER BY id ASC
      `).all(surface, chatKey, handle.runId, handle.acquisitionId) as any[];
      if (rows.length === 0) return [];
      const claimedAt = new Date().toISOString();
      const claim = this.raw.prepare(`
        UPDATE pending_messages SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?, claimed_at = ?
        WHERE id = ? AND state = 'queued'
      `);
      for (const row of rows) {
        if (row.state === "claimed" && row.claimRunId === handle.runId && row.claimAcquisitionId === handle.acquisitionId) continue;
        if (claim.run(handle.runId, handle.acquisitionId, claimedAt, row.id).changes !== 1) {
          throw new Error("pending message claim lost race");
        }
      }
      return rows.map(({ attachmentsJson, state: _state, claimRunId: _claimRunId, claimAcquisitionId: _claimAcquisitionId, ...row }) => ({ ...row, attachments: JSON.parse(attachmentsJson || "[]") }));
    });
  }

  completePendingMsg(handle: ExecutionLaneHandle, id: number): boolean {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.locks.owns(handle)) return false;
      return this.raw.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ?
      `).run(id, surface, chatKey, handle.runId, handle.acquisitionId).changes === 1;
    });
  }

  completePendingMsgs(handle: ExecutionLaneHandle, ids: number[]): boolean {
    if (ids.length === 0) return true;
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.locks.owns(handle)) return false;
      const statement = this.raw.prepare(`
        DELETE FROM pending_messages
        WHERE id = ? AND surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ?
      `);
      for (const id of ids) {
        const owned = this.raw.prepare(`
          SELECT 1 FROM pending_messages
          WHERE id = ? AND surface = ? AND chat_key = ? AND state = 'claimed' AND claim_run_id = ? AND claim_acquisition_id = ?
        `).get(id, surface, chatKey, handle.runId, handle.acquisitionId);
        if (!owned) return false;
      }
      for (const id of ids) {
        statement.run(id, surface, chatKey, handle.runId, handle.acquisitionId);
      }
      return true;
    });
  }

  admitMessage(
    surface: string,
    chatKey: string,
    msg: { prompt: string; chatId: number | string; threadId?: number | string; chatType: string; userId?: number | string; attachments?: string[]; scheduledOccurrenceKey?: string },
    maxDepth: number,
    forceQueue = false,
  ): { kind: "execute_current"; handle: ExecutionLaneHandle } | { kind: "queued"; position: number } | { kind: "full" } |
     { kind: "execute_claimed"; position: number; handle: ExecutionLaneHandle; claimed: ReturnType<BridgeDb["claimNextPendingMsg"]> & {} } {
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      const pending = this.pendingMsgCount(surface, chatKey);
      const directHandle = pending === 0 && !forceQueue ? this.locks.acquire(surface, chatKey) : null;
      if (directHandle) return { kind: "execute_current" as const, handle: directHandle };
      if (pending >= maxDepth) return { kind: "full" as const };
      this.enqueueMsg(surface, chatKey, msg);
      const position = pending + 1;
      const queueHandle = forceQueue ? null : this.locks.acquire(surface, chatKey);
      if (queueHandle) {
        const claimed = this.claimNextPendingMsg(queueHandle);
        if (claimed) return { kind: "execute_claimed" as const, position, handle: queueHandle, claimed };
      }
      return { kind: "queued" as const, position };
    });
  }

  releasePendingClaim(handle: ExecutionLaneHandle, id: number): void {
    if (!this.locks.owns(handle)) return;
    this.raw.prepare(`UPDATE pending_messages SET state = 'queued', claim_run_id = NULL, claim_acquisition_id = NULL, claimed_at = NULL WHERE id = ? AND claim_run_id = ? AND claim_acquisition_id = ?`)
      .run(id, handle.runId, handle.acquisitionId);
  }

  unlockIfQueueEmpty(handle: ExecutionLaneHandle): boolean {
    const { surface, chatKey } = handle;
    assertExecutionScope(surface, chatKey);
    return this.runInTransaction(() => {
      if (!this.ownsLock(handle)) return false;
      const pending = this.raw.prepare(`SELECT 1 FROM pending_messages WHERE surface = ? AND chat_key = ? LIMIT 1`).get(surface, chatKey);
      if (pending) return false;
      return this.unlock(handle);
    });
  }

  getQuarantinedPendingMessageCount(): number {
    const { count } = this.raw.prepare(
      `SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'`
    ).get() as { count: number };
    return count;
  }

  getPendingLaneKeys(surface: string): string[] {
    if (!surface?.trim()) throw new Error("surface is required");
    return (this.raw.prepare(`SELECT DISTINCT chat_key AS chatKey FROM pending_messages WHERE surface = ? ORDER BY chat_key`)
      .all(surface) as Array<{ chatKey: string }>).map((row) => row.chatKey);
  }

  // Historical summaries remain only for schema/data compatibility and /reset cleanup.
  addConvSummary(chatKey: string, startTurnId: number, endTurnId: number, summaryMd: string): void {
    this.conversations.addConvSummary(chatKey, startTurnId, endTurnId, summaryMd);
  }

  getLatestConvSummary(chatKey: string): {
    id: number; range_start_turn_id: number; range_end_turn_id: number; summary_md: string; created_at: string;
  } | null {
    return this.conversations.getLatestConvSummary(chatKey);
  }

  /** Issue #350 — legacy chat-key exact-turn search. */
  searchConvTurns(chatKey: string, query: string, limit?: number) {
    return this.conversations.searchConvTurns(chatKey, query, limit);
  }

  /** Explicit mechanically authorized exact-turn search. */
  searchAuthorizedConvTurns(scope: AuthorizedConversationSearchScope, query: string, limit?: number) {
    return this.conversations.searchAuthorizedConvTurns(scope, query, limit);
  }

  clearConvHistory(chatKey: string, surfaceIdentity?: string): void {
    this.conversations.clearConvHistory(chatKey, surfaceIdentity);
  }

  getConvStatus(chatKey: string, surface: string): {
    turnCount: number; pendingCount: number; latestSummaryAt: string | null; latestTurnAt: string | null;
  } {
    assertExecutionScope(surface, chatKey);
    const pc = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM pending_messages WHERE surface = ? AND chat_key = ?`)
      .get(surface, chatKey) as { n: number };
    return {
      turnCount: this.conversations.getTurnCount(chatKey, surface),
      pendingCount: pc.n,
      latestSummaryAt: this.conversations.getLatestSummaryAt(chatKey, surface),
      latestTurnAt: this.conversations.getLatestTurnAt(chatKey, surface),
    };
  }

  close(): void {
    this.raw.close();
  }
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface EventReceipt {
  id: number;
  event_id: string;
  source: string;
  event_kind: string;
  idempotency_key: string;
  received_at: string;
  occurred_at: string;
  payload_json: string;
  authority_scope: string;
  status: string;
  run_id: string | null;
  result_reference: string | null;
  error_class: string | null;
  created_at: string;
}
