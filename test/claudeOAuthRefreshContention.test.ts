import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAvailableCliKinds } from "../src/interactiveCliAuth.js";
import { claudeAcpPolicy } from "../src/providers/claudeAcpPolicy.js";
import {
  CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";
import {
  claudeRuntimeAuthDegradedFile,
  clearProviderRuntimeAuthDegraded,
  isProviderRuntimeAuthDegraded,
  markProviderRuntimeAuthDegraded,
} from "../src/providers/runtimeAvailability.js";

const contention = () => new Error(
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.",
);

describe("Claude OAuth refresh contention", () => {
  it("keeps ordinary Claude turns concurrent and makes only the contention retry exclusive", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-lock-"));
    try {
      const first = claudeAcpPolicy.credentialExecutionLock?.({ HOME: home }, 1);
      const sibling = claudeAcpPolicy.credentialExecutionLock?.({ HOME: home }, 1);
      const retry = claudeAcpPolicy.credentialExecutionLock?.({ HOME: home }, 2);

      expect(first).toEqual({
        lockFile: join(home, ".agent-bridge", "locks", "claude-credentials.lock"),
        mode: "shared",
      });
      expect(sibling).toEqual(first);
      expect(retry).toEqual({
        lockFile: first?.lockFile,
        mode: "exclusive",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves the one-shot 60-second retry and identifies the successor attempt", async () => {
    const attempts: number[] = [];
    const waits: number[] = [];
    const result = await runWithAcpTransientRetry(
      "claude",
      async (attempt) => {
        attempts.push(attempt);
        if (attempt === 1) throw contention();
        return "recovered";
      },
      {
        abortRequested: () => false,
        wait: async (delayMs) => { waits.push(delayMs); },
      },
    );

    expect(result).toBe("recovered");
    expect(attempts).toEqual([1, 2]);
    expect(waits).toEqual([CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS]);
    expect(CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS).toBe(60_000);
  });

  it("persists Claude auth degradation across Bridge processes sharing one HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-state-"));
    try {
      markProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);
      expect(existsSync(claudeRuntimeAuthDegradedFile(home))).toBe(true);

      clearProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(false);
      expect(existsSync(claudeRuntimeAuthDegradedFile(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps Claude out of selection while the shared runtime-auth marker is present", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-routing-"));
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(credentials, "{}\n");
      markProviderRuntimeAuthDegraded("claude", home);

      const unavailable = getAvailableCliKinds({
        homeDir: home,
        exists: (path) => path === credentials,
        commandExists: () => true,
        agyRuntimeReady: () => false,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(unavailable.has("claude")).toBe(false);

      clearProviderRuntimeAuthDegraded("claude", home);
      const available = getAvailableCliKinds({
        homeDir: home,
        exists: (path) => path === credentials,
        commandExists: () => true,
        agyRuntimeReady: () => false,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(available.has("claude")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
