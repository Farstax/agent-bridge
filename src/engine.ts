/**
 * PURPOSE: Public BridgeEngine facade with non-blocking startup queue recovery.
 * INPUTS: BridgeEngine construction and recovery calls.
 * OUTPUTS: The standard engine API while startup recovery runs concurrently with ingress.
 * NEIGHBORS: src/engineCore.ts, src/index-interactive.ts, src/index-health.ts
 */

export * from "./engineCore.js";
import { BridgeEngine as CoreBridgeEngine } from "./engineCore.js";

export class BridgeEngine extends CoreBridgeEngine {
  override async recoverPendingQueues(): Promise<void> {
    void super.recoverPendingQueues().catch((error) => {
      console.error(`[${this.kind}] startup queue recovery failed`, error);
    });
  }
}
