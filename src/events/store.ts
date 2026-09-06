import type { BridgeDb } from "../db.js";
import { finalizeRunTelemetry } from "../runTelemetry.js";
import type { BridgeEvent } from "./types.js";

/**
 * A dropped bridge_runs/bridge_events write leaves a run permanently
 * unauditable, with no trace it ever happened. Warn with only run/chat
 * identifiers — several event payloads carry prompt or response text, which
 * must never reach logs.
 */
function warnPersistenceFailure(phase: "collect" | "finalize", runId: string, chatKey: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[EventStore.${phase}] dropped a persistence write runId=${runId} chatKey=${chatKey}: ${reason}`);
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
  private lastFailed: Extract<BridgeEvent, { type: "run.failed" }> | null = null;
  private attemptFailurePersisted = false;

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
      } else if (event.type === "run.cancelled") {
        this._persistTerminal(event);
      } else if (event.type === "run.failed") {
        this._persistAttemptFailure(event);
      }
      // run.completed is deferred — call queueCompleted() then finalize()
    } catch (error) {
      // Persistence errors must never propagate into the execution path —
      // the CLI already ran and the user already got their answer.
      warnPersistenceFailure("collect", event.runId, event.chatKey, error);
    }
  }

  /** Store a run.completed event for deferred persistence via finalize(). */
  queueCompleted(event: Extract<BridgeEvent, { type: "run.completed" }>): void {
    this.pendingCompleted = event;
  }

  /** Persist the queued run.completed event, or settle a recorded attempt failure. */
  finalize(): void {
    if (this.pendingCompleted) {
      const { runId, chatKey } = this.pendingCompleted;
      try {
        const telemetry = finalizeRunTelemetry(
          this.pendingCompleted.runId,
          this.pendingCompleted.bot,
          this.pendingCompleted.telemetry,
        );
        this._persistTerminal({ ...this.pendingCompleted, telemetry });
      } catch (error) {
        warnPersistenceFailure("finalize", runId, chatKey, error);
      }
      this.pendingCompleted = null;
      this.lastFailed = null;
      return;
    }
    if (!this.lastFailed || this.terminalPersisted) return;
    const { runId, chatKey } = this.lastFailed;
    try {
      this._persistFailedTerminal(this.lastFailed);
    } catch (error) {
      warnPersistenceFailure("finalize", runId, chatKey, error);
    }
    this.lastFailed = null;
  }

  private _persistAttemptFailure(e: Extract<BridgeEvent, { type: "run.failed" }>): void {
    this.lastFailed = e;
    if (this.terminalPersisted) return;
    const needsRunInsert = !this.runInserted;
    const seq = this.seq + 1;
    this.db.raw.transaction(() => {
      if (needsRunInsert) this.db.insertRun(e.runId, e.chatKey, e.bot);
      this.db.insertEvent(e.runId, seq, e.type, e.timestamp, e);
    })();
    this.seq = seq;
    if (needsRunInsert) this.runInserted = true;
    this.attemptFailurePersisted = true;
  }

  private _persistFailedTerminal(e: Extract<BridgeEvent, { type: "run.failed" }>): void {
    if (this.terminalPersisted) return;
    if (this.attemptFailurePersisted) {
      const transitioned = this.db.updateRunFailed(e.runId, e.error);
      if (!transitioned) throw new Error("terminal run transition rejected");
      this.terminalPersisted = true;
      return;
    }
    this._persistTerminal(e);
  }

  // better-sqlite3 is synchronous, so a plain sequence of two .run() calls is
  // never actually atomic: a throw between insertRun() and its bridge_events
  // insert leaves a durable 'running' row with zero events, while
  // `runInserted` stays false in memory (the throw is caught before that
  // assignment) — the next attempt then re-runs insertRun(), hits the
  // run_id PRIMARY KEY, and throws again, permanently. Wrapping each pair in
  // db.raw.transaction() makes the constituent writes succeed or roll back
  // together, and in-memory flags are only ever set after the transaction
  // itself has committed, so they can never drift from durable state.
  private _persistRunStart(e: Extract<BridgeEvent, { type: "run.started" }>): void {
    if (this.runInserted) return;
    const seq = this.seq + 1;
    this.db.raw.transaction(() => {
      this.db.insertRun(e.runId, e.chatKey, e.bot);
      this.db.insertEvent(e.runId, seq, e.type, e.timestamp, e);
    })();
    this.seq = seq;
    this.runInserted = true;
  }

  private _persistTerminal(
    e: Extract<BridgeEvent, { type: "run.completed" | "run.failed" | "run.cancelled" }>
  ): void {
    if (this.terminalPersisted) return;
    const needsRunInsert = !this.runInserted;
    const seq = this.seq + 1;
    this.db.raw.transaction(() => {
      if (needsRunInsert) this.db.insertRun(e.runId, e.chatKey, e.bot);
      this.db.insertEvent(e.runId, seq, e.type, e.timestamp, e);
      let transitioned: boolean;
      if (e.type === "run.completed") {
        transitioned = this.db.updateRunCompleted(e.runId, e.text, e.sessionId);
      } else if (e.type === "run.failed") {
        transitioned = this.db.updateRunFailed(e.runId, e.error);
      } else {
        transitioned = this.db.updateRunCancelled(e.runId, e.reason);
      }
      // Terminal updates are compare-and-swapped on status='running'. A false
      // result means another terminal transition already won. Do not commit a
      // contradictory bridge_events row for a transition that did not apply.
      if (!transitioned) throw new Error("terminal run transition rejected");
    })();
    this.seq = seq;
    if (needsRunInsert) this.runInserted = true;
    this.terminalPersisted = true;
  }
}
