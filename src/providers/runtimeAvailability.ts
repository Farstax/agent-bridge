import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderId } from "./types.js";

const localRuntimeAuthDegradedProviders = new Set<ProviderId>();

export function claudeCredentialLockFile(homeDir: string = homedir()): string {
  return join(homeDir, ".agent-bridge", "locks", "claude-credentials.lock");
}

export function claudeRuntimeAuthDegradedFile(homeDir: string = homedir()): string {
  return join(homeDir, ".agent-bridge", "locks", "claude-runtime-auth-degraded");
}

/**
 * Persist only the fact that Claude auth is known unusable. Claude still owns
 * its credentials and refresh lock; this marker is Bridge routing evidence
 * shared by every Bridge process using the same HOME.
 */
export function markProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): void {
  if (providerId !== "claude") {
    localRuntimeAuthDegradedProviders.add(providerId);
    return;
  }
  const marker = claudeRuntimeAuthDegradedFile(homeDir);
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  closeSync(openSync(marker, "a", 0o600));
  chmodSync(marker, 0o600);
}

export function clearProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): void {
  if (providerId !== "claude") {
    localRuntimeAuthDegradedProviders.delete(providerId);
    return;
  }
  rmSync(claudeRuntimeAuthDegradedFile(homeDir), { force: true });
}

export function isProviderRuntimeAuthDegraded(
  providerId: ProviderId,
  homeDir: string = homedir(),
): boolean {
  if (providerId === "claude") return existsSync(claudeRuntimeAuthDegradedFile(homeDir));
  return localRuntimeAuthDegradedProviders.has(providerId);
}

export function getProviderRuntimeAuthDegradedProviders(
  homeDir: string = homedir(),
): ReadonlySet<ProviderId> {
  const degraded = new Set(localRuntimeAuthDegradedProviders);
  if (isProviderRuntimeAuthDegraded("claude", homeDir)) degraded.add("claude");
  return degraded;
}
