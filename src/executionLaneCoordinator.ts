/**
 * PURPOSE: Own transient execution-lane coordination shared across provider engines.
 * INPUTS: BridgeDb identity, stable surface identity, and lane-scoped state transitions.
 * OUTPUTS: Shared in-process coordination for cancellation, drainers, delivery, continuation, augment, and fences.
 * NEIGHBORS: src/engine.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";

export interface LaneCancellation {
  mode: "augment" | "interrupt" | "stop";
  promise: Promise<void>;
}

export interface AugmentedTask {
  prompt: string;
  attachments: string[];
}

export interface LaneDrainer {
  promise: Promise<void>;
}

export interface FinalDeliveryPhase {
  promise: Promise<void>;
  release: () => void;
}

export class ExecutionLaneCoordinator {
  private readonly cancellationOperations = new Map<string, LaneCancellation>();
  private readonly laneDrainers = new Map<string, LaneDrainer>();
  private readonly finalDeliveryPhases = new Map<string, FinalDeliveryPhase>();
  private readonly activeContinuations = new Set<string>();
  private readonly activeAugmentedTasks = new Map<string, AugmentedTask>();
  private readonly transferredAugmentedLanes = new Set<string>();
  private readonly abortedChats = new Set<string>();
  private readonly resettingChats = new Set<string>();

  getCancellation(lane: string): LaneCancellation | undefined { return this.cancellationOperations.get(lane); }
  hasCancellation(lane: string): boolean { return this.cancellationOperations.has(lane); }
  setCancellation(lane: string, cancellation: LaneCancellation): void { this.cancellationOperations.set(lane, cancellation); }
  clearCancellation(lane: string, expected?: LaneCancellation): void {
    if (!expected || this.cancellationOperations.get(lane) === expected) this.cancellationOperations.delete(lane);
  }
  cancellationCount(): number { return this.cancellationOperations.size; }

  getDrainer(lane: string): LaneDrainer | undefined { return this.laneDrainers.get(lane); }
  setDrainer(lane: string, drainer: LaneDrainer): void { this.laneDrainers.set(lane, drainer); }
  clearDrainer(lane: string, expected?: LaneDrainer): void {
    if (!expected || this.laneDrainers.get(lane) === expected) this.laneDrainers.delete(lane);
  }

  getFinalDelivery(lane: string): FinalDeliveryPhase | undefined { return this.finalDeliveryPhases.get(lane); }
  hasFinalDelivery(lane: string): boolean { return this.finalDeliveryPhases.has(lane); }
  setFinalDelivery(lane: string, phase: FinalDeliveryPhase): void { this.finalDeliveryPhases.set(lane, phase); }
  clearFinalDelivery(lane: string, expected?: FinalDeliveryPhase): void {
    if (!expected || this.finalDeliveryPhases.get(lane) === expected) this.finalDeliveryPhases.delete(lane);
  }

  markContinuationActive(lane: string): void { this.activeContinuations.add(lane); }
  clearContinuation(lane: string): void { this.activeContinuations.delete(lane); }
  isContinuationActive(lane: string): boolean { return this.activeContinuations.has(lane); }

  setAugmentedTask(lane: string, task: AugmentedTask): void { this.activeAugmentedTasks.set(lane, task); }
  hasAugmentedTask(lane: string): boolean { return this.activeAugmentedTasks.has(lane); }
  clearAugmentedTask(lane: string): void { this.activeAugmentedTasks.delete(lane); }
  augmentedTaskCount(): number { return this.activeAugmentedTasks.size; }

  markAugmentTransferred(lane: string): void { this.transferredAugmentedLanes.add(lane); }
  isAugmentTransferred(lane: string): boolean { return this.transferredAugmentedLanes.has(lane); }
  clearAugmentTransferred(lane: string): void { this.transferredAugmentedLanes.delete(lane); }

  markAborted(lane: string): void { this.abortedChats.add(lane); }
  clearAborted(lane: string): void { this.abortedChats.delete(lane); }
  isAborted(lane: string): boolean { return this.abortedChats.has(lane); }

  markResetting(lane: string): void { this.resettingChats.add(lane); }
  clearResetting(lane: string): void { this.resettingChats.delete(lane); }
  isResetting(lane: string): boolean { return this.resettingChats.has(lane); }
}

const coordinatorByDb = new WeakMap<BridgeDb, Map<string, ExecutionLaneCoordinator>>();

export function executionLaneCoordinator(db: BridgeDb, surfaceIdentity: string): ExecutionLaneCoordinator {
  let bySurface = coordinatorByDb.get(db);
  if (!bySurface) {
    bySurface = new Map<string, ExecutionLaneCoordinator>();
    coordinatorByDb.set(db, bySurface);
  }

  let coordinator = bySurface.get(surfaceIdentity);
  if (!coordinator) {
    coordinator = new ExecutionLaneCoordinator();
    bySurface.set(surfaceIdentity, coordinator);
  }
  return coordinator;
}
