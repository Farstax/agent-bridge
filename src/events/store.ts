import type { BridgeDb } from "../db.js";
import { finalizeRunTelemetry } from "../runTelemetry.js";
import type { BridgeEvent } from "./types.js";

function runChatKey(event: { chatId: string; threadId?: string }): string {
  return event.threadId ? `${event.chatId}:${event.threadId}` : event.chatId;
}

/**
 * Persists BridgeEvents to the database.
 * Extracted from BridgeEngine._createEventContext() so the persistence logic
 * is independently testable and not coupled to the engine's private state.
 */
export class EventStore {
  private db: BridgeDb;
  private seq = 0;
  private runInserted = false;
  private terminalPersisted = false;
  private pendingCompleted: Extract<BridgeEvent, { type: "run.completed" }> | null = null;

  constructor(db: BridgeDb, existingRunId?: string) {
    this.db = db;
    if (existingRunId) {
      const run = db.getRun(existingRunId);
      if (run?.status === "running") {
        this.runInserted = true;
        this.seq = db.getEventsForRun(existingRunId).reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
      }
    }
  }

  collect(event: BridgeEvent): void {
    try {
      if (event.type === "run.started") {
        this._persistRunStart(event);
      } else if (event.type === "run.failed" || event.type === "run.cancelled") {
        this._persistTerminal(event);
      }
      // run.completed is deferred — call queueCompleted() then finalize()
    } catch {
      /* persistence errors must never propagate into the execution path */
    }
  }

  /** Store a run.completed event for deferred persistence via finalize(). */
  queueCompleted(event: Extract<BridgeEvent, { type: "run.completed" }>): void {
    this.pendingCompleted = event;
  }

  /** Persist the queued run.completed event. No-op if none was queued. */
  finalize(): void {
    if (!this.pendingCompleted) return;
    try {
      const telemetry = finalizeRunTelemetry(
        this.pendingCompleted.runId,
        this.pendingCompleted.bot,
        this.pendingCompleted.telemetry,
      );
      this._persistTerminal({ ...this.pendingCompleted, telemetry });
    } catch {
      /* swallow — same policy as collect */
    }
    this.pendingCompleted = null;
  }

  private _persistRunStart(e: Extract<BridgeEvent, { type: "run.started" }>): void {
    if (this.runInserted) return;
    this.db.insertRun(e.runId, runChatKey(e), e.bot);
    this.db.insertEvent(e.runId, ++this.seq, e.type, e.timestamp, e);
    this.runInserted = true;
  }

  private _persistTerminal(
    e: Extract<BridgeEvent, { type: "run.completed" | "run.failed" | "run.cancelled" }>
  ): void {
    if (this.terminalPersisted) return;
    if (!this.runInserted) {
      this.db.insertRun(e.runId, runChatKey(e), e.bot);
      this.runInserted = true;
    }
    this.db.insertEvent(e.runId, ++this.seq, e.type, e.timestamp, e);
    if (e.type === "run.completed") {
      this.db.updateRunCompleted(e.runId, e.text, e.sessionId);
    } else if (e.type === "run.failed") {
      this.db.updateRunFailed(e.runId, e.error);
    } else {
      this.db.updateRunCancelled(e.runId, e.reason);
    }
    this.terminalPersisted = true;
  }
}
