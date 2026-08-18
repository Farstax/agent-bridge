import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  shouldCompactBeforeFallback,
  recordFallbackCompactSuccess,
} from "../src/fallbackCompactCooldown.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  delete process.env.BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS;
  delete process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED;
  vi.useRealTimers();
});

describe("fallback compact cooldown", () => {
  it("allows compaction when no prior attempt has been recorded", () => {
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(true);
  });

  it("blocks the fallback compaction entrypoint when legacy memory/compaction is disabled", () => {
    process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED = "false";
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(false);
  });

  it("blocks compaction immediately after a success is recorded", () => {
    recordFallbackCompactSuccess(db, "chat:1");
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(false);
  });

  it("allows compaction again once the cooldown window has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    recordFallbackCompactSuccess(db, "chat:1");
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z")); // +6 minutes, past default 5 min cooldown
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(true);
  });

  it("respects BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS override", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    process.env.BRIDGE_FALLBACK_COMPACT_COOLDOWN_MS = "1000";
    recordFallbackCompactSuccess(db, "chat:1");
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(false);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.500Z")); // +1.5s, past the 1s override
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(true);
  });

  it("tracks cooldown independently per chat key", () => {
    recordFallbackCompactSuccess(db, "chat:1");
    expect(shouldCompactBeforeFallback(db, "chat:1")).toBe(false);
    expect(shouldCompactBeforeFallback(db, "chat:2")).toBe(true);
  });
});
