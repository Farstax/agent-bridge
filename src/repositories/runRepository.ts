import Database from "better-sqlite3";

export interface RunningRun {
  run_id: string;
  chat_id: string;
  bot: string;
  started_at: string;
}

export interface ReconciliationEvidence {
  reason: string;
  errorMessage?: string;
  reconciledAt: string;
  processState: "absent";
  lockState: "absent";
  cutoffMs: number;
}

export class RunRepository {
  constructor(private readonly db: Database.Database) {}

  insertRun(runId: string, chatId: string, bot: string): void {
    const startedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(runId, chatId, bot, startedAt);
  }

  getRun(runId: string): any {
    return this.db
      .prepare(`SELECT * FROM bridge_runs WHERE run_id = ?`)
      .get(runId);
  }

  /**
   * All three terminal writers are compare-and-swapped on status = 'running'
   * (the same guard reconcileOrphanedRun already used below for its own
   * terminal write) so that whichever terminal transition lands first wins
   * and a late/racing writer's update is a documented no-op instead of
   * silently clobbering an already-terminal Run. Callers that need to know
   * whether their write actually applied (e.g. a fence-losing execution
   * must not report false success) can check the returned boolean.
   */
  updateRunCompleted(runId: string, text: string, sessionId: string | null): boolean {
    const endedAt = new Date().toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'done', ended_at = ?, final_text_preview = ?, session_id = ?
         WHERE run_id = ? AND status = 'running'`
      )
      .run(endedAt, text, sessionId, runId);
    return changes === 1;
  }

  updateRunFailed(runId: string, error: string): boolean {
    const endedAt = new Date().toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'failed', ended_at = ?, error = ?
         WHERE run_id = ? AND status = 'running'`
      )
      .run(endedAt, error, runId);
    return changes === 1;
  }

  updateRunCancelled(runId: string, reason: string): boolean {
    const endedAt = new Date().toISOString();
    const { changes } = this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'cancelled', ended_at = ?, error = ?
         WHERE run_id = ? AND status = 'running'`
      )
      .run(endedAt, reason, runId);
    return changes === 1;
  }

  insertEvent(runId: string, seq: number, type: string, timestamp: string, payload: any): void {
    const id = `${runId}:${seq}`;
    const payloadJson = JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, runId, seq, type, timestamp, payloadJson);
  }

  getEventsForRun(runId: string): any[] {
    return this.db
      .prepare(`SELECT * FROM bridge_events WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId);
  }

  listRunningRuns(): RunningRun[] {
    return this.db
      .prepare(`SELECT run_id, chat_id, bot, started_at FROM bridge_runs WHERE status = 'running' ORDER BY started_at ASC`)
      .all() as RunningRun[];
  }

  reconcileOrphanedRun(runId: string, endedAt: string, evidence: ReconciliationEvidence): boolean {
    const nextSeq = (this.db.prepare(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM bridge_events WHERE run_id = ?`
    ).get(runId) as { next_seq: number }).next_seq;
    const timestamp = evidence.reconciledAt;
    const insert = this.db.prepare(
      `INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const result = this.db.prepare(
      `UPDATE bridge_runs
       SET status = 'failed', ended_at = ?, error = ?
       WHERE run_id = ? AND status = 'running'`
    ).run(endedAt, evidence.errorMessage ?? evidence.reason, runId);
    if (result.changes !== 1) return false;
    insert.run(`${runId}:${nextSeq}`, runId, nextSeq, "reconciliation.started", timestamp, JSON.stringify(evidence));

    insert.run(`${runId}:${nextSeq + 1}`, runId, nextSeq + 1, "run.reconciled", timestamp, JSON.stringify(evidence));
    insert.run(`${runId}:${nextSeq + 2}`, runId, nextSeq + 2, "reconciliation.completed", timestamp, JSON.stringify({
      reason: evidence.reason,
      before: { status: "running", processState: evidence.processState, lockState: evidence.lockState },
      after: { status: "failed", endedAt },
    }));
    return true;
  }
}
