import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getCachedAvailableCliKinds,
  invalidateAvailableCliKindsCache,
  type AvailableCliOptions,
} from "../src/interactiveCliAuth.js";
import {
  claudeCredentialLockFile,
  clearProviderRuntimeAuthDegraded,
  markProviderRuntimeAuthDegraded,
} from "../src/providers/runtimeAvailability.js";
import { qualificationEvidencePath } from "../src/providers/qualification.js";

describe("getCachedAvailableCliKinds", () => {
  let homeDir: string;
  let cursorStatusCalls: number;
  let cursorVersionCalls: number;
  let baseOptions: AvailableCliOptions;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "agent-bridge-cli-cache-"));
    cursorStatusCalls = 0;
    cursorVersionCalls = 0;
    baseOptions = {
      homeDir,
      exists: () => false,
      commandExists: () => true,
      failedProviders: new Set(),
      verifyApiKey: () => false,
      readCursorStatus: () => {
        cursorStatusCalls += 1;
        return { isAuthenticated: true };
      },
      readCursorVersion: () => {
        cursorVersionCalls += 1;
        return "irrelevant";
      },
    };
    invalidateAvailableCliKindsCache();
  });

  afterEach(() => {
    invalidateAvailableCliKindsCache();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("reuses the cached result across calls when nothing has changed", () => {
    getCachedAvailableCliKinds(baseOptions);
    getCachedAvailableCliKinds(baseOptions);
    getCachedAvailableCliKinds(baseOptions);

    expect(cursorStatusCalls).toBe(1);
    expect(cursorVersionCalls).toBeLessThanOrEqual(1);
  });

  it("recomputes after a provider is marked runtime-auth-degraded", () => {
    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(1);

    markProviderRuntimeAuthDegraded("cursor", homeDir);

    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(2);
  });

  it("recomputes after a degraded provider is cleared", () => {
    markProviderRuntimeAuthDegraded("cursor", homeDir);
    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(1);

    clearProviderRuntimeAuthDegraded("cursor", homeDir);

    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(2);
  });

  it("recomputes when the Claude credential lock file's mtime changes, even from another process", () => {
    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(1);

    // Simulate a write from a different bridge process sharing the same HOME,
    // without going through this process's in-memory epoch counter.
    const lockFile = claudeCredentialLockFile(homeDir);
    mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
    writeFileSync(lockFile, "", { encoding: "utf8", mode: 0o600 });
    const bumped = new Date(Date.now() + 5000);
    utimesSync(lockFile, bumped, bumped);

    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(2);
  });

  it("recomputes when the qualification evidence file's mtime changes", () => {
    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(1);

    const evidencePath = qualificationEvidencePath(homeDir);
    writeFileSync(evidencePath, "{}", { encoding: "utf8" });
    const bumped = new Date(Date.now() + 5000);
    utimesSync(evidencePath, bumped, bumped);

    getCachedAvailableCliKinds(baseOptions);
    expect(cursorStatusCalls).toBe(2);
  });
});
