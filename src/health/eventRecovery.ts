import type { BridgeDb } from "../db.js";
import type { RunningRun } from "../repositories/runRepository.js";
import type { HealthReport } from "./types.js";
import {
  HEALTH_EVENT_SOURCE,
  HEALTH_RUN_SURFACE,
  HEALTH_RUN_CHAT_KEY,
  healthEventExecutionStartedKey,
  reconcileEventReceiptResult,
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

export interface HealthLeaseReconciliationOptions {
  /** Proves whether the process that holds/held the health execution lane
   * for this Run is still alive. Same contract as
   * OrphanReconciliationOptions.processState in src/db.ts. */
  processState: (runId: string) => "live" | "absent" | "ambiguous";
  nowMs?: number;
  onReconciled?: (run: RunningRun & { ended_at: string }) => void | Promise<void>;
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
 * id — so the health lane's lock cannot be correlated to a specific Run by
 * that column. The health lane is exclusive (surface/chat_key is a fixed,
 * unique pair), so at most one health Run is ever mid-flight through it;
 * this proves the lock abandoned only once every started, non-replayable
 * health Run's owning process is proven absent.
 */
export async function reconcileAbandonedHealthLeases(
  db: BridgeDb,
  options: HealthLeaseReconciliationOptions,
): Promise<void> {
  const startedRuns = startedNonReplayableHealthRuns(db);
  if (!startedRuns.length) return;
  const nowMs = options.nowMs ?? Date.now();
  const allOwningProcessesAbsent = startedRuns.every((run) => options.processState(run.run_id) === "absent");
  const isHealthLane = (lock: { surface: string; chat_key: string }) =>
    lock.surface === HEALTH_RUN_SURFACE && lock.chat_key === HEALTH_RUN_CHAT_KEY;

  db.reconcileStaleExecutionLocks({
    nowMs,
    reason: "health-event-restart-lease-boundary",
    lockState: (lock) => {
      if (!isHealthLane(lock)) return "live";
      const expiresMs = Date.parse(lock.lease_expires_at);
      return Number.isFinite(expiresMs) && expiresMs <= nowMs ? "stale" : "live";
    },
    containmentState: (lock) => {
      if (!isHealthLane(lock)) return "ambiguous";
      return allOwningProcessesAbsent ? "proven" : "ambiguous";
    },
  });

  await db.reconcileOrphanedRuns({
    nowMs,
    minAgeMs: 0,
    candidateRuns: startedRuns,
    processState: (run) => options.processState(run.run_id),
    containmentState: (run, state) => state === "absent" ? "proven" : "ambiguous",
    onReconciled: options.onReconciled,
  });
}
