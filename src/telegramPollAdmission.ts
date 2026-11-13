/**
 * A polled Telegram update becomes durable before its getUpdates offset
 * advances. Reuse existing event receipts and the existing poll checkpoint;
 * the unique idempotency key remains after settled payload retention.
 */
import type { BridgeDb, EventReceipt } from "./db.js";
import type { BotKind, TelegramUpdate } from "./types.js";

export const INTERACTIVE_POLL_RECEIPT_SOURCE = "telegram";

export function admitInteractivePolledUpdate(
  db: BridgeDb,
  pollKind: BotKind,
  update: TelegramUpdate,
): { receipt: EventReceipt; created: boolean } {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
    throw new Error("telegram_poll_update_id_invalid");
  }
  return db.runInTransaction(() => {
    const receivedAt = new Date().toISOString();
    const messageDate = update.message && "date" in update.message ? update.message.date : undefined;
    const identity = `telegram:interactive:${update.update_id}`;
    const admitted = db.admitEventReceipt({
      event_id: identity,
      source: INTERACTIVE_POLL_RECEIPT_SOURCE,
      event_kind: update.message ? "message" : update.callback_query ? "callback_query" : "update",
      idempotency_key: identity,
      received_at: receivedAt,
      occurred_at: typeof messageDate === "number" && Number.isSafeInteger(messageDate) && messageDate > 0
        ? new Date(messageDate * 1000).toISOString() : receivedAt,
      payload_json: JSON.stringify(update),
      authority_scope: "telegram:interactive",
    });
    // Both changes commit or roll back together; a retry can never advance
    // the polling offset without a reconstructible, once-claimable receipt.
    if (update.update_id > db.getLastUpdateId(pollKind)) {
      db.setLastUpdateId(pollKind, update.update_id);
    }
    return admitted;
  });
}
