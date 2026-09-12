/**
 * PURPOSE: Add durable queue liveness to the core BridgeEngine without creating a second executor.
 * INPUTS: Standard BridgeEngine options plus the durable BridgeDb queue/lease state.
 * OUTPUTS: The same BridgeEngine API, with shared in-process recovery kept armed for ownerless queued work.
 * NEIGHBORS: src/engineBase.ts, src/durableQueueRecovery.ts, src/db.ts
 */

export * from "./engineBase.js";

import { BridgeEngine as BaseBridgeEngine } from "./engineBase.js";
import type { BridgeEngineOptions, ExecFns } from "./engineBase.js";
import type { BridgeDb, ExecutionLaneHandle } from "./db.js";
import type { MessagingPlatform } from "./platform.js";
import type { InteractiveTurnInput } from "./interactiveIngress.js";
import { scheduleDurableQueueRecovery } from "./durableQueueRecovery.js";

type DrainCapableEngine = {
  _drainQueueAndUnlock(
    handle: ExecutionLaneHandle,
    initial?: unknown,
    recoveryAttempt?: number,
    lifecycleAlreadyManaged?: boolean,
    coalesce?: boolean,
  ): Promise<void>;
};

export class BridgeEngine extends BaseBridgeEngine {
  private readonly durableDb: BridgeDb;
  private readonly durableSurfaceIdentity: string;
  private readonly durableRecoveryCoalesce: boolean;

  constructor(
    opts: BridgeEngineOptions,
    db: BridgeDb,
    client: MessagingPlatform,
    exec: Partial<ExecFns> = {},
  ) {
    super(opts, db, client, exec);
    this.durableDb = db;
    this.durableSurfaceIdentity = opts.surfaceIdentity;
    this.durableRecoveryCoalesce = opts.busyMessageMode === "augment";
  }

  override async recoverPendingQueues(): Promise<void> {
    await Promise.all(this.durableDb.getPendingLaneKeys(this.durableSurfaceIdentity).map(async (chatKey) => {
      if (!(await this.attemptDurableQueueRecovery(chatKey))) this.armDurableQueueRecovery(chatKey);
    }));
  }

  override async recoverPendingQueue(chatKey: string): Promise<boolean> {
    if (this.durableDb.pendingMsgCount(this.durableSurfaceIdentity, chatKey) === 0) return false;
    if (!(await this.attemptDurableQueueRecovery(chatKey))) this.armDurableQueueRecovery(chatKey);
    return true;
  }

  override async handleInteractiveMessages(messages: InteractiveTurnInput[]): Promise<void> {
    const chatKey = messages[0]?.chatKey;
    try {
      await super.handleInteractiveMessages(messages);
    } finally {
      if (chatKey && this.durableDb.pendingMsgCount(this.durableSurfaceIdentity, chatKey) > 0) {
        this.armDurableQueueRecovery(chatKey);
      }
    }
  }

  private armDurableQueueRecovery(chatKey: string): void {
    scheduleDurableQueueRecovery(
      this.durableDb,
      this.durableSurfaceIdentity,
      chatKey,
      this.durableDb.lockHeartbeatMs,
      () => this.attemptDurableQueueRecovery(chatKey),
    );
  }

  private async attemptDurableQueueRecovery(chatKey: string): Promise<boolean> {
    if (this.durableDb.pendingMsgCount(this.durableSurfaceIdentity, chatKey) === 0) return true;

    const handle = this.durableDb.acquireLock(this.durableSurfaceIdentity, chatKey);
    if (!handle) return false;

    try {
      await (this as unknown as DrainCapableEngine)._drainQueueAndUnlock(
        handle,
        undefined,
        0,
        false,
        this.durableRecoveryCoalesce,
      );
    } catch (error) {
      console.error(`[${this.kind}] durable queue recovery failed chatKey=${chatKey}`, error);
    } finally {
      if (this.durableDb.ownsLock(handle)) this.durableDb.unlock(handle);
    }

    // Durable lease recovery owns liveness only until this process acquires the
    // fenced lane. Once acquired, the existing drainer and its bounded short
    // recovery budget remain the sole owners of provider/drainer failures.
    return true;
  }
}
