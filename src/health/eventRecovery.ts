import type { BridgeDb } from "../db.js";
import type { RunningRun } from "../repositories/runRepository.js";
import type { ExecutionLockRecord } from "../repositories/lockRepository.js";
import type { HealthReport } from "./types.js";
import {
  HEALTH_EVENT_SOURCE,
  HEALTH_RUN_SURFACE,
  HEALTH_RUN_CHAT_KEY,
  healthEventExecutionStartedKey,
  parseHealthEventExecutionStartedMarker,
  reconcileEventReceiptResult,
  type HealthEventExecutionLaneIdentity,
} from "./eventIngress.js";

/** Stable identity for one red episode, anchored to the last durable report. */
export function healthRedEpisodeIdempotencyKey(
  pluginName: string,
  previousReport: Pick<HealthReport, "status" | "timestamp"> | null,
): string {
  const predecessor = previousReport
    ? `${previousReport.status}:${previousReport.timestamp}`
    : "initial";
  return `health:${pluginName}:red-after:${predecessor}`;
}

/**
 * Reconcile terminal Runs before replay is considered. This closes the crash
 * window where the Run terminalized but its receipt remained run_created.
 */
export function reconcileTerminalPendingHealthEvents(db: BridgeDb): void {
  for (const receipt of db.listPendingEventReceipts()) {
    if (receipt.source !== HEALTH_EVENT_SOURCE || !receipt.run_id) continue;
    const run = db.getRun(receipt.run_id);
    if (!run || run.status === "running") continue;
    reconcileEventReceiptResult(db, receipt.id);
    db.setSetting(healthEventExecutionStartedKey(receipt.id), null);
  }
}

/**
 * Runs that have not reached the durable provider-start boundary are safe to
 * replay and must not be classified as generic orphans while startup dispatch
 * is acquiring the health lane.
 */
export function replayablePendingHealthRunIds(db: BridgeDb): Set<string> {
  const runIds = new Set<string>();
  for (const receipt of db.listPendingEventReceipts()) {
    if (receipt.source !== HEALTH_EVENT_SOURCE || !receipt.run_id) continue;
    if (db.getSetting(healthEventExecutionStartedKey(receipt.id)) !== null) continue;
    const run = db.getRun(receipt.run_id);
    if (run?.status === "running") runIds.add(run.run_id);
  }
  return runIds;
}

/**
 * The complement of replayablePendingHealthRunIds: running health Runs whose
 * durable provider-start marker proves execution already reached the
 * provider boundary, so resumeDurablePendingHealthEvents deliberately will
 * not replay them. Generic orphan reconciliation (src/db.ts
 * reconcileOrphanedRuns) has a default minimum-age cutoff and normally runs
 * once at startup — a Run interrupted seconds after the marker was written
 * is both unreplayable and too young for that pass, and with no later pass
 * it would stay 'running' indefinitely. Callers pass this candidate set
 * through reconcileOrphanedRuns with a zero-age cutoff so age no longer
 * gates reconciliation for this narrow, already-proven-unreplayable set;
 * the process-liveness/lock/claimed-message checks reconcileOrphanedRuns
 * already performs still apply.
 */
export function startedNonReplayableHealthRuns(db: BridgeDb): RunningRun[] {
  const runs: RunningRun[] = [];
  for (const receipt of db.listPendingEventReceipts()) {
    if (receipt.source !== HEALTH_EVENT_SOURCE || !receipt.run_id) continue;
    if (db.getSetting(healthEventExecutionStartedKey(receipt.id)) === null) continue;
    const run = db.getRun(receipt.run_id);
    if (run?.status === "running") runs.push(run);
  }
  return runs;
}

/**
 * The execution_locks identity (service_id/run_id/acquisition_id) each
 * started, non-replayable health Run's provider-start marker durably
 * recorded when it was written — i.e. the specific lock a crashed attempt
 * actually held, not "whatever lock currently occupies the health lane."
 * Markers written before this identity was captured (or set directly by
 * legacy plain-runId callers) yield no identity here.
 */
export function startedHealthRunLaneIdentities(db: BridgeDb): HealthEventExecutionLaneIdentity[] {
  const identities: HealthEventExecutionLaneIdentity[] = [];
  for (const receipt of db.listPendingEventReceipts()) {
    if (receipt.source !== HEALTH_EVENT_SOURCE || !receipt.run_id) continue;
    const raw = db.getSetting(healthEventExecutionStartedKey(receipt.id));
    if (raw === null) continue;
    const run = db.getRun(receipt.run_id);
    if (run?.status !== "running") continue;
    const marker = parseHealthEventExecutionStartedMarker(raw);
    if (marker.lane) identities.push(marker.lane);
  }
  return identities;
}

export interface HealthLeaseReconciliationOptions {
  /** Proves whether the process that holds/held the health execution lane
   * for this Run is still alive. Same contract as
   * OrphanReconciliationOptions.processState in src/db.ts. */
  processState: (runId: string) => "live" | "absent" | "ambiguous";
  nowMs?: number;
  onReconciled?: (run: RunningRun & { ended_at: string }) => void | Promise<void>;
  /** Called with the remaining lease duration (ms) when this pass found
   * every started, non-replayable health Run's owning process proven
   * absent, but the health lane's lock could not be reconciled this pass
   * because its lease has not yet expired. The caller should invoke this
   * reconciliation exactly once more after that delay elapses (see
   * index-health.ts) — a single bounded retry, not a rescheduling loop.
   * Not called when there is nothing left to retry, or when the owning
   * process cannot be proven absent (time is not the blocker then). */
  scheduleRetry?: (delayMs: number) => void;
}

/**
 * Terminalizes health Runs that reached the durable provider-start boundary
 * (see startedNonReplayableHealthRuns) but whose owning process is proven
 * gone. A crash right after that marker is written leaves BOTH the marker
 * AND the health execution lane's lock row durable in `execution_locks`.
 * Generic orphan reconciliation (src/db.ts reconcileOrphanedRuns) treats
 * any *existing* lock row for the Run/chat as live containment regardless
 * of the lock's own lease — so passing this candidate set through it with
 * a zero-age cutoff alone is not sufficient; the lane's lock must first be
 * proven abandoned and released through the existing stale-lock
 * reconciliation semantics (src/db.ts reconcileStaleExecutionLocks),
 * which only releases a lock once its lease has genuinely expired AND the
 * owning process is proven absent. Only after that can generic orphan
 * containment see the lane as free and terminalize the Run.
 *
 * execution_locks.run_id is the *process generation* identity a BridgeDb
 * was opened with (LockRepositoryOptions.runId), not a bridge_runs run
 * id — so a lock currently occupying the health lane can never be assumed
 * to belong to any specific started Run just because it's in that lane.
 * The lane being exclusive only guarantees at most one Run is ever
 * mid-flight through it *at a time*; it does not guarantee the lock this
 * pass observes is still the same one a crashed attempt held — ownership
 * can have legitimately changed hands (a different receipt's dispatch
 * acquired it once the crashed lease expired) before this pass ever runs.
 * Applying a crashed Run's absence-proof to whatever lock happens to be
 * there would risk releasing a live, unrelated execution's fence. Instead,
 * this only ever considers the lane's lock abandoned when its exact
 * identity (service_id/run_id/acquisition_id) still matches what a started
 * Run's own provider-start marker durably recorded — see
 * startedHealthRunLaneIdentities — and passes that as an exact-match
 * `candidateLocks` entry so a legitimately-changed lock is left untouched
 * either way.
 */
export async function reconcileAbandonedHealthLeases(
  db: BridgeDb,
  options: HealthLeaseReconciliationOptions,
): Promise<void> {
  const startedRuns = startedNonReplayableHealthRuns(db);
  if (!startedRuns.length) return;
  const nowMs = options.nowMs ?? Date.now();
  const allOwningProcessesAbsent = startedRuns.every((run) => options.processState(run.run_id) === "absent");

  const laneIdentities = startedHealthRunLaneIdentities(db);
  const currentLock = db.raw.prepare(
    `SELECT surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at
     FROM execution_locks WHERE surface = ? AND chat_key = ?`
  ).get(HEALTH_RUN_SURFACE, HEALTH_RUN_CHAT_KEY) as ExecutionLockRecord | undefined;
  const abandonedLock = currentLock && laneIdentities.some((lane) =>
    lane.serviceId === currentLock.service_id
    && lane.runId === currentLock.run_id
    && lane.acquisitionId === currentLock.acquisition_id
  ) ? currentLock : undefined;

  if (abandonedLock) {
    db.reconcileStaleExecutionLocks({
      nowMs,
      reason: "health-event-restart-lease-boundary",
      candidateLocks: [abandonedLock],
      lockState: (lock) => {
        const expiresMs = Date.parse(lock.lease_expires_at);
        return Number.isFinite(expiresMs) && expiresMs <= nowMs ? "stale" : "live";
      },
      containmentState: () => allOwningProcessesAbsent ? "proven" : "ambiguous",
    });
  }

  await db.reconcileOrphanedRuns({
    nowMs,
    minAgeMs: 0,
    candidateRuns: startedRuns,
    processState: (run) => options.processState(run.run_id),
    containmentState: (run, state) => state === "absent" ? "proven" : "ambiguous",
    onReconciled: options.onReconciled,
  });

  // A caller that only ever reconciles once at startup (as index-health.ts
  // does) can otherwise strand this Run for good: the owning process is
  // gone, but the lock survives this pass exactly when its lease had not
  // yet expired — the sole remaining obstacle is time. Schedule one bounded
  // retry for when the lease will have expired, instead of leaving the Run
  // 'running' with no later pass to catch it. Only arranged when a specific
  // abandoned lock is still correlated: if ownership has since changed
  // hands, or the lock is already gone, retrying blindly could only ever
  // misattribute again — that Run is left to the next legitimate
  // reconciliation opportunity (the lane being genuinely free needs no
  // lock-identity correlation at all).
  if (allOwningProcessesAbsent && abandonedLock && options.scheduleRetry) {
    const expiresMs = Date.parse(abandonedLock.lease_expires_at);
    const delayMs = Number.isFinite(expiresMs) ? Math.max(0, expiresMs - nowMs) : 0;
    options.scheduleRetry(delayMs);
  }
}
