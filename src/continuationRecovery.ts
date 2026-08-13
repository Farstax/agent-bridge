import type { BridgeDb } from "./db.js";
import {
  getRunOwnedProcessState,
  killRunOwnedDescendants,
  type RunOwnedProcessState,
} from "./turnContinuationProcesses.js";
import { ContinuationRepository } from "./repositories/continuationRepository.js";
import { cleanupAttachmentPaths } from "./attachmentCleanup.js";

const DEFAULT_POLL_MS = 250;

export interface CancelledContinuationRecoveryFns {
  getRunOwnedProcessState: (runId: string) => RunOwnedProcessState;
  killRunOwnedDescendants: (runId: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const defaultFns: CancelledContinuationRecoveryFns = {
  getRunOwnedProcessState,
  killRunOwnedDescendants: (runId) => killRunOwnedDescendants(runId),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * Finish containment for cancellations that were persisted before a process
 * restart but whose run-owned background work was not yet proven absent.
 * Ambiguous process inspection deliberately blocks startup rather than
 * releasing the lane or replaying the provider.
 */
export async function recoverCancelledContinuationContainment(
  db: BridgeDb,
  store = new ContinuationRepository(db.raw),
  fns: CancelledContinuationRecoveryFns = defaultFns,
  pollMs = DEFAULT_POLL_MS,
): Promise<void> {
  for (const record of store.listUncontainedCancelled()) {
    for (;;) {
      const state = fns.getRunOwnedProcessState(record.runId);
      if (state === "absent") break;
      if (state === "live") await fns.killRunOwnedDescendants(record.runId);
      await fns.sleep(pollMs);
    }
    const contained = store.markCancellationContained(record.runId);
    if (!contained) continue;
    if (!db.pendingMessagesOwnAnyAttachments(record.attachments ?? [])) cleanupAttachmentPaths(record.attachments ?? []);
    db.updateRunCancelled(record.runId, record.terminalReason ?? "cancelled");
  }
}
