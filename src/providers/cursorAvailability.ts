import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadBotsConfig } from "../config.js";
import { getQualificationFailedProviders } from "./qualificationStatus.js";
import type { ProviderId } from "./types.js";

export interface CursorStatusSnapshot {
  readonly isAuthenticated: boolean;
}

export interface CursorAvailabilityOptions {
  homeDir?: string;
  exists?: (path: string) => boolean;
  env?: Record<string, string | undefined>;
  failedProviders?: ReadonlySet<ProviderId>;
  command?: string;
  readStatus?: () => CursorStatusSnapshot;
}

export function resolveCursorAuthPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".config", "cursor", "auth.json"),
    join(homeDir, ".cursor", "auth.json"),
  ];
}

export function readCursorCliStatus(
  command: string,
  execFile: typeof execFileSync = execFileSync,
): CursorStatusSnapshot {
  const raw = execFile(command, ["status", "--format", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).trim();
  if (!raw) throw new Error("Cursor status command returned no output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cursor status command returned malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cursor status command returned malformed JSON");
  }
  const record = parsed as Record<string, unknown>;
  const isAuthenticated = record.isAuthenticated === true || record.status === "authenticated";
  return { isAuthenticated };
}

/**
 * Cursor auth readiness uses only the live-qualified
 * `cursor-agent status --format json` contract. Credential files and
 * CURSOR_API_KEY are not authentication evidence for Agent Bridge.
 */
export function isCursorAuthenticated(options: CursorAvailabilityOptions = {}): boolean {
  const env = options.env ?? process.env;
  const readStatus = options.readStatus ?? (() => {
    const command = options.command ?? loadBotsConfig(env).cursor.command;
    return readCursorCliStatus(command);
  });

  try {
    return readStatus().isAuthenticated;
  } catch {
    return false;
  }
}

/**
 * Cursor is routeable when authenticated unless current qualification evidence
 * proves a deterministic failure. Missing/stale/degraded evidence is diagnostic,
 * not a routing prerequisite. Cursor remains opt-in for default chains.
 */
export function isCursorRouteable(options: CursorAvailabilityOptions = {}): boolean {
  if (!isCursorAuthenticated(options)) return false;
  const failedProviders = options.failedProviders ?? getQualificationFailedProviders();
  return !failedProviders.has("cursor");
}

