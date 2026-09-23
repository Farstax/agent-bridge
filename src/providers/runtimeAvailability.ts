import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./types.js";

const CLAUDE_RUNTIME_AUTH_DEGRADED = "runtime-auth-degraded";
const localRuntimeAuthDegradedProviders = new Set<ProviderId>();

interface ClaudeRuntimeAuthDegradedRecord {
  schemaVersion: 1;
  state: typeof CLAUDE_RUNTIME_AUTH_DEGRADED;
  provider: "claude";
  markedAt: string;
}

export function claudeCredentialLockFile(homeDir: string = homedir()): string {
  return join(homeDir, ".agent-bridge", "locks", "claude-credentials.lock");
}

function readClaudeRuntimeAuthDegraded(
  homeDir: string = homedir(),
): ClaudeRuntimeAuthDegradedRecord | null {
  try {
    const raw = readFileSync(claudeCredentialLockFile(homeDir), "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ClaudeRuntimeAuthDegradedRecord>;
    if (
      parsed.schemaVersion !== 1
      || parsed.state !== CLAUDE_RUNTIME_AUTH_DEGRADED
      || parsed.provider !== "claude"
      || typeof parsed.markedAt !== "string"
    ) return null;
    return parsed as ClaudeRuntimeAuthDegradedRecord;
  } catch {
    return null;
  }
}

/**
 * Persist Claude runtime-auth degradation beside the existing Bridge credential
 * coordination owner so every process using the same HOME sees the same state.
 * Claude still owns credentials and its own refresh lock.
 */
export function markProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): void {
  if (providerId !== "claude") {
    localRuntimeAuthDegradedProviders.add(providerId);
    return;
  }
  const lockFile = claudeCredentialLockFile(homeDir);
  mkdirSync(dirname(lockFile), { recursive: true, mode: 0o700 });
  const record: ClaudeRuntimeAuthDegradedRecord = {
    schemaVersion: 1,
    state: CLAUDE_RUNTIME_AUTH_DEGRADED,
    provider: "claude",
    markedAt: new Date().toISOString(),
  };
  writeFileSync(lockFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function clearProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): void {
  if (providerId !== "claude") {
    localRuntimeAuthDegradedProviders.delete(providerId);
    return;
  }
  if (!readClaudeRuntimeAuthDegraded(homeDir)) return;
  writeFileSync(claudeCredentialLockFile(homeDir), "", { encoding: "utf8", mode: 0o600 });
}

export function isProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): boolean {
  if (providerId === "claude") return readClaudeRuntimeAuthDegraded(homeDir) !== null;
  return localRuntimeAuthDegradedProviders.has(providerId);
}

export function getProviderRuntimeAuthDegradedProviders(
  homeDir: string = homedir(),
): ReadonlySet<ProviderId> {
  const degraded = new Set(localRuntimeAuthDegradedProviders);
  if (isProviderRuntimeAuthDegraded("claude", homeDir)) degraded.add("claude");
  return degraded;
}
