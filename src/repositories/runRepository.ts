import Database from "better-sqlite3";

export interface RunningRun {
  run_id: string;
  chat_id: string;
  bot: string;
  started_at: string;
}

export interface ReconciliationEvidence {
  reason: string;
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

  updateRunCompleted(runId: string, text: string, sessionId: string | null): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'done', ended_at = ?, final_text_preview = ?, session_id = ?
         WHERE run_id = ?`
      )
      .run(endedAt, text, sessionId, runId);
  }

  updateRunFailed(runId: string, error: string): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'failed', ended_at = ?, error = ?
         WHERE run_id = ?`
      )
      .run(endedAt, error, runId);
  }

  updateRunCancelled(runId: string, reason: string): void {
    const endedAt = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE bridge_runs
         SET status = 'cancelled', ended_at = ?, error = ?
         WHERE run_id = ?`
      )
      .run(endedAt, reason, runId);
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
    insert.run(`${runId}:${nextSeq}`, runId, nextSeq, "reconciliation.started", timestamp, JSON.stringify(evidence));
    const result = this.db.prepare(
      `UPDATE bridge_runs
       SET status = 'failed', ended_at = ?, error = ?
       WHERE run_id = ? AND status = 'running'`
      ).run(endedAt, "Process interrupted by bridge restart", runId);
    if (result.changes !== 1) return false;

    insert.run(`${runId}:${nextSeq + 1}`, runId, nextSeq + 1, "run.reconciled", timestamp, JSON.stringify(evidence));
    insert.run(`${runId}:${nextSeq + 2}`, runId, nextSeq + 2, "reconciliation.completed", timestamp, JSON.stringify({
      reason: evidence.reason,
      before: { status: "running", processState: evidence.processState, lockState: evidence.lockState },
      after: { status: "failed", endedAt },
    }));
    return true;
  }
}
