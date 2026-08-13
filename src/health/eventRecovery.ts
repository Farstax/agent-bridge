import type { BridgeDb } from "../db.js";
import type { HealthReport } from "./types.js";
import {
  HEALTH_EVENT_SOURCE,
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
