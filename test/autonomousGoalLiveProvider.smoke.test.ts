import { describe, expect, it } from "vitest";

describe("autonomous goal live-provider smoke", () => {
  it.skipIf(process.env.AGENT_BRIDGE_LIVE_AUTONOMOUS_SMOKE !== "1")(
    "reaches the configured real provider boundary in one bounded non-destructive cycle",
    async () => {
      const databasePath = process.env.AGENT_BRIDGE_LIVE_AUTONOMOUS_DB;
      if (!databasePath) throw new Error("AGENT_BRIDGE_LIVE_AUTONOMOUS_DB is required for the opt-in smoke");
      const { runAutonomousGoalLiveSmoke } = await import("../src/autonomousGoalRuntime.js");
      const result = await runAutonomousGoalLiveSmoke(databasePath);
      expect(result.providerBoundaryReached).toBe(true);
      expect(["complete", "blocked", "cancelled", "budget_exhausted"]).toContain(result.status);
    },
  );
});
