/**
 * PURPOSE: Own transient execution-lane coordination shared across provider engines.
 * INPUTS: BridgeDb identity, stable surface identity, and lane-scoped state transitions.
 * OUTPUTS: Shared in-process coordination for pre-provider ingress, cancellation, drainers, delivery, augment, and fences.
 * NEIGHBORS: src/engine.ts, src/db.ts
 */

import type { BridgeDb } from "./db.js";

export interface LaneCancellation {
  mode: "augment" | "interrupt" | "stop";
  promise: Promise<void>;
}

export interface PreProviderIngressScope {
  readonly controller: AbortController;
  state: "preparing" | "aborted" | "claimed";
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
  private readonly preProviderIngressScopes = new Map<string, Set<PreProviderIngressScope>>();
  private readonly laneDrainers = new Map<string, LaneDrainer>();
  private readonly finalDeliveryPhases = new Map<string, FinalDeliveryPhase>();
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

  beginPreProviderIngress(lane: string): PreProviderIngressScope {
    // A scope always starts open. It is only aborted by an explicit stop/reset
    // (markAborted -> abortPreProviderIngress) that lands while the scope is
    // still tracked here. A lingering stop/reset flag from a *prior* fence
    // must not retroactively block a *new* message's ingress: ordinary
    // durable admission (db.admitMessage) already owns queuing/coalescing
    // once the pre-provider claim succeeds.
    const scope: PreProviderIngressScope = { controller: new AbortController(), state: "preparing" };
    let scopes = this.preProviderIngressScopes.get(lane);
    if (!scopes) {
      scopes = new Set<PreProviderIngressScope>();
      this.preProviderIngressScopes.set(lane, scopes);
    }
    scopes.add(scope);
    return scope;
  }

  abortPreProviderIngress(lane: string): number {
    const scopes = this.preProviderIngressScopes.get(lane);
    if (!scopes) return 0;
    let aborted = 0;
    for (const scope of scopes) {
      if (scope.state !== "preparing") continue;
      scope.state = "aborted";
      scope.controller.abort();
      aborted += 1;
    }
    return aborted;
  }

  claimPreProviderIngress(lane: string, scope: PreProviderIngressScope): boolean {
    const scopes = this.preProviderIngressScopes.get(lane);
    if (!scopes?.has(scope) || scope.state !== "preparing" || scope.controller.signal.aborted) return false;
    scope.state = "claimed";
    scopes.delete(scope);
    if (scopes.size === 0) this.preProviderIngressScopes.delete(lane);
    return true;
  }

  clearPreProviderIngress(lane: string, scope: PreProviderIngressScope): void {
    const scopes = this.preProviderIngressScopes.get(lane);
    if (!scopes) return;
    scopes.delete(scope);
    if (scopes.size === 0) this.preProviderIngressScopes.delete(lane);
  }

  preProviderIngressCount(lane?: string): number {
    if (lane) return this.preProviderIngressScopes.get(lane)?.size ?? 0;
    let count = 0;
    for (const scopes of this.preProviderIngressScopes.values()) count += scopes.size;
    return count;
  }

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

  setAugmentedTask(lane: string, task: AugmentedTask): void { this.activeAugmentedTasks.set(lane, task); }
  hasAugmentedTask(lane: string): boolean { return this.activeAugmentedTasks.has(lane); }
  clearAugmentedTask(lane: string): void { this.activeAugmentedTasks.delete(lane); }
  augmentedTaskCount(): number { return this.activeAugmentedTasks.size; }

  markAugmentTransferred(lane: string): void { this.transferredAugmentedLanes.add(lane); }
  isAugmentTransferred(lane: string): boolean { return this.transferredAugmentedLanes.has(lane); }
  clearAugmentTransferred(lane: string): void { this.transferredAugmentedLanes.delete(lane); }

  // markAborted is also used by the non-stop "augment"/"interrupt" busy-mode
  // coalescing paths (see BridgeEngine._cancelLane), where it must NOT tear
  // down other in-flight pre-provider ingress scopes (e.g. a concurrently
  // arriving message's voice transcription) that are legitimately queuing
  // for the same lane. Only a real /stop fences pre-provider ingress; callers
  // that mean an actual stop call abortPreProviderIngress explicitly.
  markAborted(lane: string): void {
    this.abortedChats.add(lane);
  }
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
