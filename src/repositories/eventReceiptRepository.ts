import Database from "better-sqlite3";
import type { EventReceipt } from "../db.js";

export class EventReceiptRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert-or-return-existing on idempotency_key. Duplicate delivery of the
   * same key must never create a second receipt row.
   */
  createReceipt(input: {
    event_id: string;
    source: string;
    event_kind: string;
    idempotency_key: string;
    received_at: string;
    occurred_at: string;
    payload_json: string;
    authority_scope: string;
  }): EventReceipt {
    const existing = this.getByIdempotencyKey(input.idempotency_key);
    if (existing) return existing;
    return this.db.prepare(
      `INSERT INTO event_receipts
         (event_id, source, event_kind, idempotency_key, received_at, occurred_at, payload_json, authority_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    ).get(
      input.event_id,
      input.source,
      input.event_kind,
      input.idempotency_key,
      input.received_at,
      input.occurred_at,
      input.payload_json,
      input.authority_scope,
    ) as EventReceipt;
  }

  /**
   * Atomic insert-or-report for surfaces that must know whether this delivery
   * is the first (a retry of an already admitted event must not redispatch).
   */
  admitReceipt(input: Parameters<EventReceiptRepository["createReceipt"]>[0]): { receipt: EventReceipt; created: boolean } {
    const inserted = this.db.prepare(
      `INSERT INTO event_receipts
         (event_id, source, event_kind, idempotency_key, received_at, occurred_at, payload_json, authority_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING *`
    ).get(
      input.event_id, input.source, input.event_kind, input.idempotency_key,
      input.received_at, input.occurred_at, input.payload_json, input.authority_scope,
    ) as EventReceipt | undefined;
    if (inserted) return { receipt: inserted, created: true };
    return { receipt: this.getByIdempotencyKey(input.idempotency_key)!, created: false };
  }

  /** Exactly one caller wins the right to dispatch a receipt. */
  claimDispatch(id: number): boolean {
    return this.db.prepare(
      `UPDATE event_receipts SET status = 'dispatching' WHERE id = ? AND status = 'received'`
    ).run(id).changes === 1;
  }

  /** Terminal transition for an in-flight receipt, with or without a Run. */
  finish(id: number, input: { status: "completed" | "failed" | "cancelled" | "ambiguous"; result_reference?: string | null; error_class?: string | null }): void {
    this.db.prepare(
      `UPDATE event_receipts SET status = ?, result_reference = ?, error_class = ?
       WHERE id = ? AND status IN ('dispatching', 'run_created')`
    ).run(input.status, input.result_reference ?? null, input.error_class ?? null, id);
  }

  listBySourceAndStatus(source: string, statuses: readonly string[]): EventReceipt[] {
    if (statuses.length === 0) return [];
    return this.db.prepare(
      `SELECT * FROM event_receipts WHERE source = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id ASC`
    ).all(source, ...statuses) as EventReceipt[];
  }

  countBySourceAndStatus(source: string, status: string): number {
    return Number((this.db.prepare(
      `SELECT COUNT(*) AS n FROM event_receipts WHERE source = ? AND status = ?`
    ).get(source, status) as { n: number }).n);
  }

  getById(id: number): EventReceipt | null {
    return (this.db.prepare(`SELECT * FROM event_receipts WHERE id = ?`).get(id) as EventReceipt | undefined) ?? null;
  }

  getByIdempotencyKey(idempotencyKey: string): EventReceipt | null {
    return (this.db.prepare(
      `SELECT * FROM event_receipts WHERE idempotency_key = ?`
    ).get(idempotencyKey) as EventReceipt | undefined) ?? null;
  }

  listPending(): EventReceipt[] {
    return this.db.prepare(
      `SELECT * FROM event_receipts WHERE status IN ('received', 'run_created') ORDER BY id ASC`,
    ).all() as EventReceipt[];
  }

  /**
   * Compare-and-swapped on status = 'received' | 'dispatching' so a racing linker (e.g. two
   * processes both replaying the same interrupted event) can only ever link
   * one Run to a given receipt.
   */
  linkRun(id: number, runId: string): void {
    this.db.prepare(
      `UPDATE event_receipts
         SET run_id = ?,
             status = CASE WHEN status IN ('received', 'dispatching') THEN 'run_created' ELSE status END
       WHERE id = ? AND run_id IS NULL AND status IN ('received', 'dispatching', 'completed')`
    ).run(runId, id);
  }

  recordResult(id: number, input: { status: "completed" | "failed" | "cancelled"; result_reference: string | null; error_class: string | null }): void {
    this.db.prepare(
      `UPDATE event_receipts SET status = ?, result_reference = ?, error_class = ? WHERE id = ? AND status = 'run_created'`
    ).run(input.status, input.result_reference, input.error_class, id);
  }
}
