import { capacityWaitNotice } from "../src/interactiveBot.js";
import { describe, expect, it } from "vitest";
import { capacityRetryAfterSeconds, combineCapacityRetryOpportunities } from "../src/providers/capacityRetryTiming.js";

describe("capacity retry timing", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  it("accepts a near-future provider reset with a small guard", () => {
    const error = Object.assign(new Error("limited"), {
      data: { capacityResetsAt: "2026-10-13T12:00:20.000Z" },
    });
    expect(capacityRetryAfterSeconds(error, now)).toBe(25);
  });

  it("preserves a validated daily-window retry instead of turning it into a tight poll", () => {
    const error = Object.assign(new Error("limited"), {
      data: { capacityResetsAt: "2026-10-14T00:00:00.000Z" },
    });
    expect(capacityRetryAfterSeconds(error, now)).toBe(43_205);
  });

  it("rejects malformed, stale, and implausibly distant reset telemetry", () => {
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "nope" } }), now)).toBeNull();
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "2026-10-13T11:59:59.000Z" } }), now)).toBeNull();
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "2026-10-22T12:00:00.000Z" } }), now)).toBeNull();
  });
  describe("combineCapacityRetryOpportunities", () => {
    it("preserves bounded unknown backoff when known reset is later (order: known then unknown)", () => {
      const combined = combineCapacityRetryOpportunities(
        { retryAfterSeconds: 7200 },
        { hasUnknownCapacityTiming: true }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 300,
        hasUnknownCapacityTiming: true,
      });
    });

    it("preserves bounded unknown backoff when known reset is later (order: unknown then known)", () => {
      const combined = combineCapacityRetryOpportunities(
        { hasUnknownCapacityTiming: true },
        { retryAfterSeconds: 7200 }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 300,
        hasUnknownCapacityTiming: true,
      });
    });

    it("selects earlier known reset when it is strictly before the unknown backoff (order: known then unknown)", () => {
      const combined = combineCapacityRetryOpportunities(
        { retryAfterSeconds: 60 },
        { hasUnknownCapacityTiming: true }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 60,
      });
    });

    it("selects earlier known reset when it is strictly before the unknown backoff (order: unknown then known)", () => {
      const combined = combineCapacityRetryOpportunities(
        { hasUnknownCapacityTiming: true },
        { retryAfterSeconds: 60 }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 60,
      });
    });

    it("selects earliest reset across known providers", () => {
      const combined = combineCapacityRetryOpportunities(
        { retryAfterSeconds: 7200 },
        { retryAfterSeconds: 1800 }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 1800,
      });
    });

    it("retains unknown timing when all providers have unknown timing", () => {
      const combined = combineCapacityRetryOpportunities(
        { hasUnknownCapacityTiming: true },
        { hasUnknownCapacityTiming: true }
      );
      expect(combined).toEqual({
        retryAfterSeconds: 300,
        hasUnknownCapacityTiming: true,
      });
    });
  });

  describe("capacityWaitNotice timezone", () => {
    it("formats explicitly in UTC when no user timezone is provided", () => {
      const notice = capacityWaitNotice(60, undefined);
      expect(notice).toContain("(UTC)");
      expect(notice).not.toContain("Europe/");
    });

    it("formats in specified user timezone when reliably available", () => {
      const notice = capacityWaitNotice(60, undefined, "America/New_York");
      expect(notice).toContain("(America/New_York)");
    });

    it("emits generic notice when timing is unknown regardless of retryAfterSeconds", () => {
      const notice = capacityWaitNotice(300, true);
      expect(notice).toBe("All available providers are temporarily at capacity. I’ll retry automatically and continue your task when one becomes available.");
    });
  });

});
