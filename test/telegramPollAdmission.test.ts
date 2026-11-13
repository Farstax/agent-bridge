import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { admitInteractivePolledUpdate, INTERACTIVE_POLL_RECEIPT_SOURCE } from "../src/telegramPollAdmission.js";
import type { TelegramUpdate } from "../src/types.js";

const pollKind = "codex";
const makeUpdate = (id: number): TelegramUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    chat: { id: 100, type: "private" },
    from: { id: 42, first_name: "User" },
    date: 1_700_000_000 + id,
    text: `instruction-${id}`,
  },
} as TelegramUpdate);

describe("interactive Telegram poll receipt boundary (#1221)", () => {
  it("commits received payload and polling checkpoint together, without dispatching a provider", () => {
    const db = openDb(":memory:");
    const update = makeUpdate(31);
    const admitted = admitInteractivePolledUpdate(db, pollKind, update);

    expect(admitted.created).toBe(true);
    expect(admitted.receipt.status).toBe("received");
    expect(admitted.receipt.source).toBe(INTERACTIVE_POLL_RECEIPT_SOURCE);
    expect(JSON.parse(admitted.receipt.payload_json)).toEqual(update);
    expect(db.getLastUpdateId(pollKind)).toBe(31);
    expect(db.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["received"])).toHaveLength(1);
    db.close();
  });

  it("deduplicates Telegram redelivery and preserves chronological acceptance order", () => {
    const db = openDb(":memory:");
    const first = admitInteractivePolledUpdate(db, pollKind, makeUpdate(40));
    const second = admitInteractivePolledUpdate(db, pollKind, makeUpdate(41));
    const duplicate = admitInteractivePolledUpdate(db, pollKind, makeUpdate(40));

    expect(duplicate.created).toBe(false);
    expect(duplicate.receipt.id).toBe(first.receipt.id);
    expect(db.getLastUpdateId(pollKind)).toBe(41);
    expect(db.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["received"]).map((row) => row.id))
      .toEqual([first.receipt.id, second.receipt.id]);
    expect(db.claimEventReceiptDispatch(first.receipt.id)).toBe(true);
    expect(db.claimEventReceiptDispatch(first.receipt.id)).toBe(false);
    db.finishEventReceipt(first.receipt.id, { status: "completed" });
    expect(admitInteractivePolledUpdate(db, pollKind, makeUpdate(40)).created).toBe(false);
    db.close();
  });

  it("rolls back both receipt and checkpoint on failed durable acceptance", () => {
    const db = openDb(":memory:");
    vi.spyOn(db, "setLastUpdateId").mockImplementationOnce(() => {
      throw new Error("simulated SQLite checkpoint failure");
    });
    expect(() => admitInteractivePolledUpdate(db, pollKind, makeUpdate(50))).toThrow("simulated SQLite checkpoint failure");
    expect(db.getLastUpdateId(pollKind)).toBe(0);
    expect(db.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["received"])).toHaveLength(0);
    db.close();
  });

  it("recovers unclaimed updates after restart, but refuses redispatch of claimed/linked receipts", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-telegram-admission-"));
    const path = join(dir, "bridge.sqlite");
    try {
      const initial = openDb(path);
      const neverStarted = admitInteractivePolledUpdate(initial, pollKind, makeUpdate(61));
      const interrupted = admitInteractivePolledUpdate(initial, pollKind, makeUpdate(62));
      expect(initial.claimEventReceiptDispatch(interrupted.receipt.id)).toBe(true);
      initial.close();

      const restarted = openDb(path);
      expect(restarted.getLastUpdateId(pollKind)).toBe(62);
      expect(restarted.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["received"]).map((row) => row.id))
        .toEqual([neverStarted.receipt.id]);
      expect(restarted.listEventReceipts(INTERACTIVE_POLL_RECEIPT_SOURCE, ["dispatching"]).map((row) => row.id))
        .toEqual([interrupted.receipt.id]);
      expect(admitInteractivePolledUpdate(restarted, pollKind, makeUpdate(62)).created).toBe(false);
      restarted.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
