import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildFileLockedInvocation } from "../workspaceLock.js";
import type { ProviderId } from "./types.js";

const CLAUDE_RUNTIME_AUTH_DEGRADED = "runtime-auth-degraded";
const CLAUDE_RUNTIME_AUTH_RECOVERY_PROBE_INTERVAL_MS = 60_000;
const localRuntimeAuthDegradedProviders = new Set<ProviderId>();

interface CredentialFingerprint {
  mtimeMs: number;
  size: number;
  ino: number;
}

interface ClaudeRuntimeAuthDegradedRecord {
  schemaVersion: 1;
  state: typeof CLAUDE_RUNTIME_AUTH_DEGRADED;
  provider: "claude";
  markedAt: string;
  credential: CredentialFingerprint | null;
  lastProbeAt?: string | null;
}

export function claudeCredentialLockFile(homeDir: string = homedir()): string {
  return join(homeDir, ".agent-bridge", "locks", "claude-credentials.lock");
}

function claudeCredentialFile(homeDir: string): string {
  return join(homeDir, ".claude", ".credentials.json");
}

function credentialFingerprint(homeDir: string): CredentialFingerprint | null {
  try {
    const stat = statSync(claudeCredentialFile(homeDir));
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameFingerprint(a: CredentialFingerprint | null, b: CredentialFingerprint | null): boolean {
  return a?.mtimeMs === b?.mtimeMs
    && a?.size === b?.size
    && a?.ino === b?.ino;
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
 * Runtime auth degradation shares Claude's existing Agent Bridge credential
 * coordination file so every Bridge process using the same HOME sees the same
 * readiness state without owning or rewriting Claude's credential files.
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
    credential: credentialFingerprint(homeDir),
    lastProbeAt: null,
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

/**
 * Re-enable Claude only after provider-owned re-authentication changed the
 * credential file and Claude's bounded native auth-status command confirms the
 * new credential state. The exclusive non-blocking Bridge lock prevents this
 * auth-sensitive check from overlapping a login, retry, or other exclusive
 * credential operation.
 */
export function recoverClaudeRuntimeAuthDegradation(options: {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  execFile?: typeof execFileSync;
} = {}): boolean {
  const homeDir = options.homeDir ?? homedir();
  const degraded = readClaudeRuntimeAuthDegraded(homeDir);
  if (!degraded) return true;

  const currentCredential = credentialFingerprint(homeDir);
  const credentialChanged = !sameFingerprint(degraded.credential, currentCredential);
  const lastProbeMs = degraded.lastProbeAt ? Date.parse(degraded.lastProbeAt) : Number.NaN;
  if (
    !credentialChanged
    && Number.isFinite(lastProbeMs)
    && Date.now() - lastProbeMs < CLAUDE_RUNTIME_AUTH_RECOVERY_PROBE_INTERVAL_MS
  ) {
    return false;
  }

  const env = { ...process.env, ...(options.env ?? {}), HOME: homeDir };
  const claude = env.CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const invocation = buildFileLockedInvocation(
    claude,
    ["auth", "status", "--json"],
    claudeCredentialLockFile(homeDir),
    "exclusive",
    { nonBlocking: true },
  );
  try {
    (options.execFile ?? execFileSync)(invocation.command, invocation.args, {
      env,
      stdio: "ignore",
      timeout: 5_000,
    });
    clearProviderRuntimeAuthDegraded("claude", homeDir);
    return true;
  } catch {
    const stillDegraded = readClaudeRuntimeAuthDegraded(homeDir);
    if (stillDegraded) {
      writeFileSync(
        claudeCredentialLockFile(homeDir),
        `${JSON.stringify({ ...stillDegraded, lastProbeAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    return false;
  }
}
