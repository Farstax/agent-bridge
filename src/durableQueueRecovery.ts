/**
 * PURPOSE: Deduplicate durable queue-recovery polling across engines sharing one runtime/database.
 * INPUTS: BridgeDb identity, surface/lane identity, bounded retry delay, and the owning engine attempt.
 * OUTPUTS: At most one in-process recovery timer per durable lane until recovery settles or owns the lane.
 * NEIGHBORS: src/engine.ts, src/db.ts, src/executionLaneCoordinator.ts
 */

import type { BridgeDb } from "./db.js";

type RecoveryAttempt = () => Promise<boolean>;

type RecoveryState = {
  attempt: RecoveryAttempt;
  delayMs: number;
  generation: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
};

const recoveryByDb = new WeakMap<BridgeDb, Map<string, Map<string, RecoveryState>>>();

function laneRecoveries(db: BridgeDb, surfaceIdentity: string): Map<string, RecoveryState> {
  let bySurface = recoveryByDb.get(db);
  if (!bySurface) {
    bySurface = new Map<string, Map<string, RecoveryState>>();
    recoveryByDb.set(db, bySurface);
  }
  let lanes = bySurface.get(surfaceIdentity);
  if (!lanes) {
    lanes = new Map<string, RecoveryState>();
    bySurface.set(surfaceIdentity, lanes);
  }
  return lanes;
}

export function scheduleDurableQueueRecovery(
  db: BridgeDb,
  surfaceIdentity: string,
  chatKey: string,
  delayMs: number,
  attempt: RecoveryAttempt,
): void {
  const lanes = laneRecoveries(db, surfaceIdentity);
  const existing = lanes.get(chatKey);
  if (existing) {
    existing.attempt = attempt;
    existing.delayMs = Math.max(1, delayMs);
    existing.generation += 1;
    return;
  }

  const state: RecoveryState = {
    attempt,
    delayMs: Math.max(1, delayMs),
    generation: 0,
    timer: null,
    running: false,
  };
  lanes.set(chatKey, state);

  const arm = () => {
    if (lanes.get(chatKey) !== state || state.timer || state.running) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.running = true;
      const generation = state.generation;
      void state.attempt()
        .then((done) => {
          if (lanes.get(chatKey) !== state) return;
          if (done && state.generation === generation) {
            lanes.delete(chatKey);
            return;
          }
          state.running = false;
          arm();
        })
        .catch((error) => {
          console.error(`[queue-recovery] durable recovery attempt failed surface=${surfaceIdentity} chatKey=${chatKey}`, error);
          if (lanes.get(chatKey) !== state) return;
          state.running = false;
          arm();
        });
    }, state.delayMs);
    state.timer.unref();
  };

  arm();
}
