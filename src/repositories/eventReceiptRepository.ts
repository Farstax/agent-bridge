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

  getById(id: number): EventReceipt | null {
    return (this.db.prepare(`SELECT * FROM event_receipts WHERE id = ?`).get(id) as EventReceipt | undefined) ?? null;
  }

  getByIdempotencyKey(idempotencyKey: string): EventReceipt | null {
    return (this.db.prepare(
      `SELECT * FROM event_receipts WHERE idempotency_key = ?`
    ).get(idempotencyKey) as EventReceipt | undefined) ?? null;
  }

  /**
   * Compare-and-swapped on status = 'received' so a racing linker (e.g. two
   * processes both replaying the same interrupted event) can only ever link
   * one Run to a given receipt.
   */
  linkRun(id: number, runId: string): void {
    this.db.prepare(
      `UPDATE event_receipts SET status = 'run_created', run_id = ? WHERE id = ? AND status = 'received'`
    ).run(runId, id);
  }

  recordResult(id: number, input: { status: "completed" | "failed" | "cancelled"; result_reference: string | null; error_class: string | null }): void {
    this.db.prepare(
      `UPDATE event_receipts SET status = ?, result_reference = ?, error_class = ? WHERE id = ? AND status = 'run_created'`
    ).run(input.status, input.result_reference, input.error_class, id);
  }
}
