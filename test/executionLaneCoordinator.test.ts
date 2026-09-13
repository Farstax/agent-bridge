import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDb } from "../src/db.js";
import { executionLaneCoordinator } from "../src/executionLaneCoordinator.js";

const LANE = JSON.stringify(["telegram:interactive", "100"]);

afterEach(() => {
  vi.useRealTimers();
});

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

  it("owns shared fence and augment state", () => {
    const db = {} as BridgeDb;
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    const sharedView = executionLaneCoordinator(db, "telegram:interactive");

    coordinator.markAborted(LANE);
    coordinator.markResetting(LANE);
    coordinator.setAugmentedTask(LANE, { prompt: "work", attachments: ["/tmp/a"] });

    expect(sharedView.isAborted(LANE)).toBe(true);
    expect(sharedView.isResetting(LANE)).toBe(true);
    expect(sharedView.hasAugmentedTask(LANE)).toBe(true);

    sharedView.clearAborted(LANE);
    sharedView.clearResetting(LANE);
    sharedView.clearAugmentedTask(LANE);

    expect(coordinator.isAborted(LANE)).toBe(false);
    expect(coordinator.isResetting(LANE)).toBe(false);
    expect(coordinator.hasAugmentedTask(LANE)).toBe(false);
  });

  it("owns a live steering handle scoped per lane, cleared when the turn ends", () => {
    const db = {} as BridgeDb;
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    const sharedView = executionLaneCoordinator(db, "telegram:interactive");
    const steer = vi.fn().mockResolvedValue({ outcome: "injected" });

    expect(coordinator.getSteerHandle(LANE)).toBeUndefined();

    coordinator.setSteerHandle(LANE, steer);
    expect(sharedView.getSteerHandle(LANE)).toBe(steer);

    coordinator.clearSteerHandle(LANE);
    expect(sharedView.getSteerHandle(LANE)).toBeUndefined();
  });

  it("stops durable recovery when the canonical drainer takes ownership", async () => {
    vi.useFakeTimers();
    const db = {} as BridgeDb;
    const coordinator = executionLaneCoordinator(db, "telegram:interactive");
    const attempt = vi.fn().mockResolvedValue(false);

    coordinator.scheduleRecovery(LANE, 100, attempt);
    coordinator.setDrainer(LANE, { promise: Promise.resolve() });

    await vi.advanceTimersByTimeAsync(200);

    expect(attempt).not.toHaveBeenCalled();
    coordinator.clearDrainer(LANE);
  });
});
