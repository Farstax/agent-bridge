/**
 * PURPOSE: Route durable queue recovery through the shared execution-lane coordinator.
 * INPUTS: BridgeDb identity, surface/lane identity, retry delay, and the owning engine attempt.
 * OUTPUTS: One in-process recovery operation per durable lane across provider engines.
 * NEIGHBORS: src/engine.ts, src/db.ts, src/executionLaneCoordinator.ts
 */

import type { BridgeDb } from "./db.js";
import { executionLaneCoordinator, type LaneRecoveryAttempt } from "./executionLaneCoordinator.js";

export function scheduleDurableQueueRecovery(
  db: BridgeDb,
  surfaceIdentity: string,
  chatKey: string,
  delayMs: number,
  attempt: LaneRecoveryAttempt,
): void {
  executionLaneCoordinator(db, surfaceIdentity).scheduleRecovery(chatKey, delayMs, attempt);
}
