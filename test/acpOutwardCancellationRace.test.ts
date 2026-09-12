import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
  beginExecutionLifecycle,
  completeExecutionLifecycle,
  isAbortRequested,
} from "../src/cli.js";
import { openDb } from "../src/db.js";
import {
  BridgeOutwardAcpPromptExecutor,
  OUTWARD_ACP_SURFACE,
} from "../src/acpServer/execution.js";
import { OutwardAcpSessionRepository } from "../src/repositories/outwardAcpSessionRepository.js";

describe("outward ACP cancellation ownership", () => {
  it("keeps cancellation asserted when it arrives before Bridge lifecycle registration", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-outward-cancel-race-"));
    const db = openDb(join(root, "bridge.sqlite"), { databaseRole: "interactive" });
    try {
      const session = new OutwardAcpSessionRepository(db.raw).create({
        sessionId: "outward-race",
        conversationId: "acp:cancel-race",
        cwd: root,
      });

      let enteredEngine!: () => void;
      const engineEntered = new Promise<void>((resolve) => { enteredEngine = resolve; });
      let releaseLifecycle!: () => void;
      const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve; });

      const executor = new BridgeOutwardAcpPromptExecutor({
        db,
        providerChain: ["codex"] as const,
        runId: () => "run-cancel-race",
        createEngine: () => ({
          executeSurfaceNeutralTurn: async (input) => {
            enteredEngine();
            await lifecycleGate;

            const lane = JSON.stringify([OUTWARD_ACP_SURFACE, input.chatKey]);
            const lifecycleToken = beginExecutionLifecycle(lane, input.laneHandle);
            try {
              const deadline = Date.now() + 500;
              while (!isAbortRequested(lane) && Date.now() < deadline) {
                await delay(1);
              }
              expect(isAbortRequested(lane)).toBe(true);
              return {
                text: "cancelled work must not escape",
                sessionId: null,
                stopReason: "cancelled" as const,
              };
            } finally {
              completeExecutionLifecycle(lane, lifecycleToken);
            }
          },
        }),
      });

      const execution = executor.execute({
        session,
        prompt: "cancel during lifecycle handoff",
        signal: new AbortController().signal,
        onUpdate: () => undefined,
      });
      await engineEntered;

      const cancellation = executor.cancel(session);
      releaseLifecycle();

      const [response] = await Promise.all([execution, cancellation]);
      expect(response.stopReason).toBe("cancelled");
      expect(db.getRun("run-cancel-race")?.status).toBe("cancelled");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
