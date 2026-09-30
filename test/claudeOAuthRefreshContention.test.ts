import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

  it("keeps Claude unavailable when credentials have not changed after terminal auth failure", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-gated-"));
    const bin = join(home, "bin");
    const claude = join(bin, "claude");
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(claude, "#!/bin/sh\nexit 1\n");
      chmodSync(claude, 0o755);
      writeFileSync(credentials, "{}\n");

      markProviderRuntimeAuthDegraded("claude", home);
      const unavailable = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(unavailable.has("claude")).toBe(false);

      clearProviderRuntimeAuthDegraded("claude", home);
      const available = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(available.has("claude")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("persists Claude auth degradation in the shared credential coordination file", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-state-"));
    const lockFile = join(home, ".agent-bridge", "locks", "claude-credentials.lock");
    try {
      markProviderRuntimeAuthDegraded("claude", home);
      expect(readFileSync(lockFile, "utf8")).toContain("runtime-auth-degraded");
      clearProviderRuntimeAuthDegraded("claude", home);
      expect(readFileSync(lockFile, "utf8")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restores Claude availability only after explicit successful execution evidence clears degradation", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-cleared-"));
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(credentials, "{}\n");
      markProviderRuntimeAuthDegraded("claude", home);

      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);
      clearProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(false);

      const available = getAvailableCliKinds({
        homeDir: home,
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        failedProviders: new Set(),
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(available.has("claude")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("readmits Claude when credentials are updated after runtime-auth degradation without manual clear", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-readmit-"));
    const bin = join(home, "bin");
    const claude = join(bin, "claude");
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(claude, "#!/bin/sh\nexit 1\n");
      chmodSync(claude, 0o755);
      writeFileSync(credentials, "{\"token\":\"old\"}\n");

      // 1. Terminal auth failure marks Claude degraded
      markProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);

      // 2. Routing excludes Claude
      const beforeRefresh = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(beforeRefresh.has("claude")).toBe(false);

      // 3. To simulate an earlier failure timestamp:
      const lockPath = join(home, ".agent-bridge", "locks", "claude-credentials.lock");
      const pastMs = Date.now() - 10_000;
      writeFileSync(lockPath, JSON.stringify({
        schemaVersion: 1,
        state: "runtime-auth-degraded",
        provider: "claude",
        markedAt: new Date(pastMs).toISOString(),
      }) + "\n");
      utimesSync(lockPath, pastMs / 1000, pastMs / 1000);

      // User reauthenticates: credentials file is written with current timestamp (> past markedAt)
      const credMs = Date.now() - 5_000;
      writeFileSync(credentials, "{\"token\":\"refreshed\"}\n");
      utimesSync(credentials, credMs / 1000, credMs / 1000);

      // 4. Degradation is now considered superseded; readmitted for verification attempt
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(false);

      // 5. Routing now includes Claude without explicit clearProviderRuntimeAuthDegraded
      const afterRefresh = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(afterRefresh.has("claude")).toBe(true);

      // 6. If execution fails again, re-marking sets current markedAt (> credMs) and excludes Claude again
      markProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);
      const afterReFailure = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });
      expect(afterReFailure.has("claude")).toBe(false);

      // 7. Successful execution clears the lock file through existing clear path
      clearProviderRuntimeAuthDegraded("claude", home);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps Claude degraded when credentials are empty or missing despite marker", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-empty-"));
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      markProviderRuntimeAuthDegraded("claude", home);
      // No credentials file
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);

      // Empty credentials file with newer mtime
      writeFileSync(credentials, "");
      const futureSeconds = (Date.now() + 5000) / 1000;
      utimesSync(credentials, futureSeconds, futureSeconds);
      expect(isProviderRuntimeAuthDegraded("claude", home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not apply Claude credential freshness semantics to other providers", () => {
    const home = mkdtempSync(join(tmpdir(), "other-provider-runtime-auth-"));
    try {
      markProviderRuntimeAuthDegraded("codex", home);
      expect(isProviderRuntimeAuthDegraded("codex", home)).toBe(true);
      clearProviderRuntimeAuthDegraded("codex", home);
      expect(isProviderRuntimeAuthDegraded("codex", home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
