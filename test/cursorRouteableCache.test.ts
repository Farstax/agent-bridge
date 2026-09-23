import { beforeEach, describe, expect, it } from "vitest";
import {
  invalidateCursorRouteableCache,
  isCursorRouteableCached,
  type CursorAvailabilityOptions,
} from "../src/providers/cursorAvailability.js";
import { CURSOR_ACP_VERSION } from "../src/providers/cursorAcpConfig.js";

describe("isCursorRouteableCached", () => {
  let statusCalls: number;
  let versionCalls: number;
  let clockMs: number;
  let baseOptions: CursorAvailabilityOptions;

  beforeEach(() => {
    statusCalls = 0;
    versionCalls = 0;
    clockMs = 0;
    baseOptions = {
      homeDir: "/home/tester",
      exists: () => false,
      env: {},
      failedProviders: new Set(),
      readStatus: () => {
        statusCalls += 1;
        return { isAuthenticated: true };
      },
      readVersion: () => {
        versionCalls += 1;
        return CURSOR_ACP_VERSION;
      },
    };
    invalidateCursorRouteableCache();
  });

  it("reuses the probe result for repeated calls within the TTL window", () => {
    isCursorRouteableCached(baseOptions, () => clockMs);
    isCursorRouteableCached(baseOptions, () => clockMs);
    isCursorRouteableCached(baseOptions, () => clockMs);

    expect(statusCalls).toBe(1);
  });

  it("re-probes once the TTL has elapsed", () => {
    isCursorRouteableCached(baseOptions, () => clockMs);
    expect(statusCalls).toBe(1);

    clockMs += 5001; // just past the 5s TTL

    isCursorRouteableCached(baseOptions, () => clockMs);
    expect(statusCalls).toBe(2);
  });

  it("reflects a status flip only after the TTL elapses, not immediately", () => {
    let authenticated = false;
    const options: CursorAvailabilityOptions = {
      ...baseOptions,
      readStatus: () => {
        statusCalls += 1;
        return { isAuthenticated: authenticated };
      },
    };

    expect(isCursorRouteableCached(options, () => clockMs)).toBe(false);

    authenticated = true; // e.g. the user just finished `cursor-agent login`
    expect(isCursorRouteableCached(options, () => clockMs)).toBe(false); // still cached

    clockMs += 5001;
    expect(isCursorRouteableCached(options, () => clockMs)).toBe(true); // re-probed
  });
});
