import { beforeEach, describe, expect, it } from "vitest";
import {
  getCachedAvailableCliKinds,
  type AvailableCliOptions,
} from "../src/interactiveCliAuth.js";
import { invalidateCursorRouteableCache } from "../src/providers/cursorAvailability.js";

const cursorStatusUnavailable = () => {
  throw new Error("Cursor status unavailable in test");
};

describe("getCachedAvailableCliKinds", () => {
  beforeEach(() => {
    invalidateCursorRouteableCache();
  });

  it("reflects a freshly authenticated non-Cursor provider on the very next call, with no staleness window", () => {
    const authenticatedPaths = new Set<string>();
    const options: AvailableCliOptions = {
      homeDir: "/home/tester",
      exists: (path) => authenticatedPaths.has(path),
      commandExists: () => true,
      failedProviders: new Set(),
      readCursorStatus: cursorStatusUnavailable,
    };

    expect(getCachedAvailableCliKinds(options).has("codex")).toBe(false);

    // The user just finished `codex login` -- its credential file now exists.
    authenticatedPaths.add("/home/tester/.codex/auth.json");

    expect(getCachedAvailableCliKinds(options).has("codex")).toBe(true);
  });

  it("does not let two callers with different injected checks collide on a shared cache entry", () => {
    const codexOnly: AvailableCliOptions = {
      homeDir: "/home/tester",
      exists: (path) => path.endsWith("codex/auth.json"),
      commandExists: () => true,
      failedProviders: new Set(),
      readCursorStatus: cursorStatusUnavailable,
    };
    const claudeOnly: AvailableCliOptions = {
      homeDir: "/home/tester",
      exists: (path) => path.endsWith(".credentials.json"),
      commandExists: () => true,
      failedProviders: new Set(),
      readCursorStatus: cursorStatusUnavailable,
    };

    expect(getCachedAvailableCliKinds(codexOnly).has("codex")).toBe(true);
    expect(getCachedAvailableCliKinds(codexOnly).has("claude")).toBe(false);
    expect(getCachedAvailableCliKinds(claudeOnly).has("codex")).toBe(false);
    expect(getCachedAvailableCliKinds(claudeOnly).has("claude")).toBe(true);
  });
});
