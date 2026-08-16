import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import {
  AUTONOMOUS_EVENT_SOURCE,
  cancelAutonomousGoal,
  createAutonomousGoal,
  getAutonomousGoal,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";

function removeDb(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-wal`, { force: true });
}

describe("autonomous goal cancellation fencing", () => {
  it("durably fences the Run before waiting for cross-process termination", async () => {
    const dbPath = join(tmpdir(), `autonomous-cancel-fence-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(dbPath, { serviceId: "cancel-fence-test", runId: `test-${Math.random()}` });
    createAutonomousGoal(db, {
      goalId: "cancel-fence-race",
      prompt: "Keep going",
      constraints: [],
      bot: "claude",
      maxCycles: 3,
    });

    let releaseProvider!: () => void;
    const providerFinished = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const engine = {
      executeSurfaceNeutralTurn: async () => {
        await providerFinished;
        return {
          text: JSON.stringify({
            status: "progress",
            evidence: "late progress",
            nextWakeReason: "continue",
          }),
        };
      },
    } as any;

    const attempt = runNextAutonomousGoal(db, "cancel-fence-race", engine);
    while ((db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?")
      .get("autonomous:cancel-fence-race") as { count: number }).count !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    await cancelAutonomousGoal(db, "cancel-fence-race", "owner stop", {
      killRunOwnedDescendants: async () => {
        // Simulate the real cancellation boundary: terminating the provider
        // makes the separate run process settle while cancel is still waiting
        // for process containment. The durable Run fence must already exist.
        releaseProvider();
        await attempt;
      },
    });

    expect(getAutonomousGoal(db, "cancel-fence-race").status).toBe("cancelled");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ? AND status = 'received'")
      .get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 0 });

    db.close();
    removeDb(dbPath);
  });
});
