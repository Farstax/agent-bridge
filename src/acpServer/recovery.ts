import { readProcessStartTicks } from "../cliSupervisor.js";
import type { BridgeDb } from "../db.js";
import { getRunOwnedProcessState, type RunOwnedProcessState } from "../runOwnedProcesses.js";
export const OUTWARD_ACP_SURFACE = "acp:outward";

/** Identify the actual stdio owner without relying on a reusable PID alone. */
export function outwardServiceId(): string {
  const ticks = readProcessStartTicks(process.pid);
  return ticks ? `acp:outward/${process.pid}/${ticks}` : "acp:outward";
}

function ownerAbsent(serviceId: string): boolean {
  const match = /^acp:outward\/([1-9][0-9]*)\/([0-9]+)$/.exec(serviceId);
  if (!match) return false; // legacy/unknown ownership stays fenced
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid > 0x7fffffff) return false;
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const ticks = readProcessStartTicks(pid);
  return ticks !== null && ticks !== match[2];
}

/** Reconcile only lanes whose process owner and every associated provider are absent. */
export async function recoverOutwardLanes(db: BridgeDb): Promise<void> {
  const now = Date.now();
  const runs = db.listRunningRuns(OUTWARD_ACP_SURFACE);
  const states = new Map<string, RunOwnedProcessState>();
  const state = (id: string): RunOwnedProcessState => {
    let value = states.get(id);
    if (!value) { value = getRunOwnedProcessState(id); states.set(id, value); }
    return value;
  };
  const released = db.reconcileStaleExecutionLocks({
    nowMs: now,
    reason: "outward_acp_service_restart",
    containmentState: (lock) => lock.surface === OUTWARD_ACP_SURFACE && ownerAbsent(lock.service_id)
      && state(lock.run_id) === "absent"
      && runs.filter((run) => run.chat_id === lock.chat_key).every((run) => state(run.run_id) === "absent")
      ? "proven" : "ambiguous",
    lockState: (lock) => lock.surface === OUTWARD_ACP_SURFACE && Date.parse(lock.lease_expires_at) <= now ? "stale" : "live",
  });
  const releasedChats = new Set(released.map((lock) => lock.chat_key));
  // A process can die after releasing the lock but before transitioning the
  // Run. The durable release audit supplies the original owner and lease; a
  // fresh containment check is still required before completing recovery.
  const auditFor = db.raw.prepare(`SELECT before_json, completed_at FROM reconciliation_audit
    WHERE kind = 'lock' AND status = 'completed' AND reason = 'outward_acp_service_restart'
      AND subject_id = ? ORDER BY completed_at DESC`);
  const wasSafelyReleased = (run: (typeof runs)[number]): boolean => {
    const audits = auditFor.all(`${OUTWARD_ACP_SURFACE}:${run.chat_id}`) as Array<{ before_json: string; completed_at: string }>;
    return audits.some((audit) => {
      try {
        const lock = JSON.parse(audit.before_json) as { surface?: string; chat_key?: string; service_id?: string; acquired_at?: string; run_id?: string };
        return lock.surface === OUTWARD_ACP_SURFACE && lock.chat_key === run.chat_id && typeof lock.service_id === "string"
          && typeof lock.run_id === "string" && typeof lock.acquired_at === "string"
          && Date.parse(lock.acquired_at) <= Date.parse(run.started_at) && Date.parse(run.started_at) <= Date.parse(audit.completed_at)
          && ownerAbsent(lock.service_id) && state(lock.run_id) === "absent" && state(run.run_id) === "absent";
      } catch { return false; }
    });
  };
  await db.reconcileOrphanedRuns({
    nowMs: now,
    minAgeMs: 0,
    candidateRuns: runs.filter((run) => releasedChats.has(run.chat_id) || wasSafelyReleased(run)),
    processState: (run) => state(run.run_id),
    containmentState: (_run, processState) => processState === "absent" ? "proven" : "ambiguous",
  });
}
