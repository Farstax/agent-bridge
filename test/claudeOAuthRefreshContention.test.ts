import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      writeFileSync(claude, "#!/bin/sh\nexit 0\n");
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

  it("restores Claude availability after bounded native auth status proves re-authentication", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-recovery-"));
    const bin = join(home, "bin");
    const claude = join(bin, "claude");
    const credentials = join(home, ".claude", ".credentials.json");
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(claude, "#!/bin/sh\nexit 0\n");
      chmodSync(claude, 0o755);
      writeFileSync(credentials, "{}\n");

      markProviderRuntimeAuthDegraded("claude", home);
      writeFileSync(credentials, "{\"reauthenticated\":true}\n");
      const available = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });

      expect(available.has("claude")).toBe(true);
      expect(readFileSync(join(home, ".agent-bridge", "locks", "claude-credentials.lock"), "utf8")).toBe("");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps Claude degraded when changed credentials fail native auth status", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-runtime-auth-rejected-"));
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
      writeFileSync(credentials, "{\"candidate\":true}\n");
      const available = getAvailableCliKinds({
        homeDir: home,
        env: { HOME: home, PATH: bin },
        commandExists: () => true,
        agyRuntimeReady: () => false,
        exists: (path) => path === credentials,
        readCursorStatus: () => ({ isAuthenticated: false }),
      });

      expect(available.has("claude")).toBe(false);
      expect(readFileSync(join(home, ".agent-bridge", "locks", "claude-credentials.lock"), "utf8"))
        .toContain("runtime-auth-degraded");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
