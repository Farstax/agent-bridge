import { describe, expect, it } from "vitest";
import type { BridgeDb } from "../src/db.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";

const LANE = JSON.stringify(["telegram:interactive", "100"]);

describe("execution lane coordinator ownership", () => {
  it("shares one coordinator for the same database and surface", () => {
    const db = {} as BridgeDb;

    const first = executionLaneCoordinator(db, "telegram:interactive");
    const second = executionLaneCoordinator(db, "telegram:interactive");

    expect(second).toBe(first);
  });

  it("isolates coordinators across surfaces and database identities", () => {
    const db = {} as BridgeDb;
    const otherDb = {} as BridgeDb;

    const coordinator = executionLaneCoordinator(db, "telegram:interactive");

    expect(executionLaneCoordinator(db, "discord:interactive")).not.toBe(coordinator);
    expect(executionLaneCoordinator(otherDb, "telegram:interactive")).not.toBe(coordinator);
  });

  it("owns shared continuation, fence, and augment state", () => {
    const db = {} as BridgeDb;
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    const sharedView = executionLaneCoordinator(db, "telegram:interactive");

    coordinator.markContinuationActive(LANE);
    coordinator.markAborted(LANE);
    coordinator.markResetting(LANE);
    coordinator.setAugmentedTask(LANE, { prompt: "work", attachments: ["/tmp/a"] });

    expect(sharedView.isContinuationActive(LANE)).toBe(true);
    expect(sharedView.isAborted(LANE)).toBe(true);
    expect(sharedView.isResetting(LANE)).toBe(true);
    expect(sharedView.hasAugmentedTask(LANE)).toBe(true);

    sharedView.clearContinuation(LANE);
    sharedView.clearAborted(LANE);
    sharedView.clearResetting(LANE);
    sharedView.clearAugmentedTask(LANE);

    expect(coordinator.isContinuationActive(LANE)).toBe(false);
    expect(coordinator.isAborted(LANE)).toBe(false);
    expect(coordinator.isResetting(LANE)).toBe(false);
    expect(coordinator.hasAugmentedTask(LANE)).toBe(false);
  });
});
