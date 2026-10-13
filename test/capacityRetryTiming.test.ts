import { describe, expect, it } from "vitest";
import { capacityRetryAfterSeconds } from "../src/providers/capacityRetryTiming.js";

describe("capacity retry timing", () => {
  const now = Date.parse("2026-10-13T12:00:00.000Z");

  it("accepts a near-future provider reset with a small guard", () => {
    const error = Object.assign(new Error("limited"), {
      data: { capacityResetsAt: "2026-10-13T12:00:20.000Z" },
    });
    expect(capacityRetryAfterSeconds(error, now)).toBe(25);
  });

  it("rejects malformed, stale, and implausibly distant reset telemetry", () => {
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "nope" } }), now)).toBeNull();
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "2026-10-13T11:59:59.000Z" } }), now)).toBeNull();
    expect(capacityRetryAfterSeconds(Object.assign(new Error("limited"), { data: { capacityResetsAt: "2026-10-22T12:00:00.000Z" } }), now)).toBeNull();
  });
});
