/**
 * PURPOSE: Process-local standalone readiness file for the Slack companion
 * (#943, status schema v1). A connected record is an observation of one live
 * process, never a promise that Slack routes events to it. No token, socket
 * URL, event payload or message text is ever written.
 * INPUTS: process identity and socket transitions.
 * OUTPUTS: atomically replaced 0600 JSON at SLACK_STATUS_FILE.
 * NEIGHBORS: src/index-slack-interactive.ts
 */
import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SLACK_STATUS_SCHEMA_VERSION = 1;
export const SLACK_STATUS_HEARTBEAT_MS = 15_000;
export const SLACK_STATUS_MAX_AGE_MS = 45_000;

export type SlackStatusState = "connecting" | "connected" | "reconnecting" | "disconnected" | "reconnect_required" | "failed";
export type SlackStatusErrorCode =
  | "token_invalid" | "token_revoked" | "token_class_unsupported" | "app_mismatch" | "app_unverified"
  | "identity_unavailable" | "allowlist_invalid" | "database_unavailable" | "socket_error" | "status_unavailable";

export interface SlackStatusRecord {
  schemaVersion: 1;
  pid: number;
  generation: string;
  observedAt: string;
  state: SlackStatusState;
  appId: string | null;
  teamId: string | null;
  botUserId: string | null;
  lastConnectedAt: string | null;
  errorCode: SlackStatusErrorCode | null;
}

export class SlackStatusWriter {
  readonly generation = randomUUID();
  private state: SlackStatusState = "connecting";
  private appId: string | null = null;
  private teamId: string | null = null;
  private botUserId: string | null = null;
  private lastConnectedAt: string | null = null;
  private errorCode: SlackStatusErrorCode | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** True once a write failed: health must degrade rather than claim ready. */
  writeFailed = false;

  constructor(private readonly path: string | null, private readonly now: () => number = Date.now) {}

  setIdentity(identity: { appId: string; teamId: string; botUserId: string }): void {
    this.appId = identity.appId;
    this.teamId = identity.teamId;
    this.botUserId = identity.botUserId;
    this.flush();
  }

  /**
   * `connected` with a non-null errorCode is a degraded observation (for
   * example the database refused an admission); consumers must not report it
   * as fully connected.
   */
  transition(state: SlackStatusState, errorCode: SlackStatusErrorCode | null = null): void {
    if (state === "connected" && this.state !== "connected") this.lastConnectedAt = new Date(this.now()).toISOString();
    this.state = state;
    this.errorCode = errorCode;
    this.flush();
  }

  /** Clears a degraded observation once the condition has passed. */
  clearDegraded(): void {
    if (this.state !== "connected" || this.errorCode === null) return;
    this.errorCode = null;
    this.flush();
  }

  /** Invalidate any prior generation immediately, then refresh while alive. */
  start(): void {
    this.flush();
    this.timer = setInterval(() => this.flush(), SLACK_STATUS_HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(finalState: SlackStatusState = "disconnected"): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = finalState;
    this.flush();
  }

  snapshot(): SlackStatusRecord {
    return {
      schemaVersion: 1,
      pid: process.pid,
      generation: this.generation,
      observedAt: new Date(this.now()).toISOString(),
      state: this.state,
      appId: this.appId,
      teamId: this.teamId,
      botUserId: this.botUserId,
      lastConnectedAt: this.lastConnectedAt,
      errorCode: this.errorCode,
    };
  }

  private flush(): void {
    if (!this.path) return;
    const tmp = join(dirname(this.path), `.${process.pid}.${this.generation}.status.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(this.snapshot()), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
      this.writeFailed = false;
    } catch {
      this.writeFailed = true;
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
  }
}

/** Consumer-side freshness rule documented in docs/slack.md. */
export function isSlackStatusCurrent(record: SlackStatusRecord, expected: { pid: number; generation?: string; appId?: string; teamId?: string }, nowMs = Date.now()): boolean {
  if (record.schemaVersion !== 1 || record.state !== "connected" || record.errorCode !== null) return false;
  if (record.pid !== expected.pid) return false;
  if (expected.generation && record.generation !== expected.generation) return false;
  if (expected.appId && record.appId !== expected.appId) return false;
  if (expected.teamId && record.teamId !== expected.teamId) return false;
  const age = nowMs - Date.parse(record.observedAt);
  return Number.isFinite(age) && age >= 0 && age <= SLACK_STATUS_MAX_AGE_MS;
}
