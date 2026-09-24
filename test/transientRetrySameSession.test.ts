import { describe, expect, it } from "vitest";
import {
  TRANSIENT_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";

describe("generic transient same-session retry (tier 1)", () => {
  it("retries once, on the same session, for any provider's transient error -- not just Claude's OAuth contention", async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await runWithAcpTransientRetry(
      "codex",
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) throw new Error("Selected model is at capacity. Please try a different model.");
        return "recovered";
      },
      {
        abortRequested: () => false,
        wait: async (delayMs) => { waits.push(delayMs); },
      },
    );

    expect(result).toBe("recovered");
    expect(attempts).toEqual([1, 2]);
    expect(waits).toEqual([TRANSIENT_RETRY_DELAY_MS]);
    // Explicitly not the 60s Claude-OAuth-contention delay -- an ordinary
    // transient blip should not wait anywhere near that long.
    expect(TRANSIENT_RETRY_DELAY_MS).toBeLessThan(10_000);
  });

  it("does not retry a non-transient error (e.g. capacity_exhausted) -- only transient qualifies for tier 1", async () => {
    const attempts: number[] = [];
    const waits: number[] = [];

    await expect(runWithAcpTransientRetry(
      "codex",
      async (attempt) => {
        attempts.push(attempt);
        throw new Error("usage limit reached");
      },
      {
        abortRequested: () => false,
        wait: async (delayMs) => { waits.push(delayMs); },
      },
    )).rejects.toThrow("usage limit reached");

    expect(attempts).toEqual([1]);
    expect(waits).toEqual([]);
  });

  it("does not retry an auth_required error", async () => {
    const attempts: number[] = [];

    await expect(runWithAcpTransientRetry(
      "codex",
      async (attempt) => {
        attempts.push(attempt);
        throw new Error("authentication required");
      },
      { abortRequested: () => false },
    )).rejects.toThrow("authentication required");

    expect(attempts).toEqual([1]);
  });
});
