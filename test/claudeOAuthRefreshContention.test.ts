import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAcpPolicy } from "../src/providers/claudeAcpPolicy.js";
import {
  CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";
import {
  clearProviderRuntimeAuthDegraded,
  markProviderRuntimeAuthDegraded,
} from "../src/providers/runtimeAvailability.js";
import { getQualificationFailedProviders } from "../src/providers/qualificationStatus.js";

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

  it("routes a known terminal auth failure as unavailable until recovery evidence clears it", () => {
    clearProviderRuntimeAuthDegraded("claude");
    try {
      markProviderRuntimeAuthDegraded("claude");
      expect(getQualificationFailedProviders("/nonexistent/provider-qualification.json")).toContain("claude");

      clearProviderRuntimeAuthDegraded("claude");
      expect(getQualificationFailedProviders("/nonexistent/provider-qualification.json")).not.toContain("claude");
    } finally {
      clearProviderRuntimeAuthDegraded("claude");
    }
  });
});
