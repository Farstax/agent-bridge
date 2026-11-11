import type { BridgeDb } from "../db.js";

// Display-only submitted prompts. These live in the guest's existing SQLite
// settings table; they are never claimable queue work or provider context.
const PREFIX = "outward-queued-display:";
const keyFor = (correlationKey: string) => `${PREFIX}${correlationKey}`;
const sessionPrefix = (sessionId: string) => `${PREFIX}acp-request:${sessionId}:`;

type DisplayRecord = {
  text: string;
  createdAt: string;
  state: "pending" | "cancelled" | "failed";
  attachments: number;
};

export function rememberQueuedDisplay(
  db: BridgeDb, sessionId: string, requestId: string, text: string, attachments: number,
): void {
  const key = keyFor(`acp-request:${sessionId}:${requestId}`);
  // Called inside the same immediate transaction as queue admission.
  if (db.getSetting(key) !== null) return;
  db.setSetting(key, JSON.stringify({
    text, createdAt: new Date().toISOString(), state: "pending", attachments,
  } satisfies DisplayRecord));
}

export function settleQueuedDisplay(
  db: BridgeDb, correlationKey: string, state: "cancelled" | "failed" | "pending",
): void {
  const key = keyFor(correlationKey);
  const raw = db.getSetting(key);
  if (raw === null) return;
  const previous = JSON.parse(raw) as DisplayRecord;
  db.setSetting(key, JSON.stringify({ ...previous, state }));
}

export function retireQueuedDisplay(db: BridgeDb, correlationKey: string): void {
  db.raw.prepare("DELETE FROM settings WHERE key = ?").run(keyFor(correlationKey));
}

export function clearQueuedDisplay(db: BridgeDb, sessionId: string): void {
  const prefix = sessionPrefix(sessionId);
  db.raw.prepare("DELETE FROM settings WHERE key >= ? AND key < ?")
    .run(prefix, `${prefix}\uffff`);
}

/** Scoped readback for Desk history only. Never insert into provider replay. */
export function listQueuedDisplay(db: BridgeDb, sessionId: string): Array<{
  id: string;
  role: "user";
  text: string;
  createdAt: string;
  state: DisplayRecord["state"];
  admitted: true;
}> {
  const prefix = sessionPrefix(sessionId);
  const rows = db.raw.prepare(
    "SELECT key, value FROM settings WHERE key >= ? AND key < ?",
  ).all(prefix, `${prefix}\uffff`) as Array<{ key: string; value: string }>;
  return rows.map(({ key, value }) => {
    const record = JSON.parse(value) as DisplayRecord;
    return {
      id: `user-${key.slice(prefix.length)}`,
      role: "user" as const,
      text: record.text || (record.attachments ? "Attachment (no longer available after cancellation)" : ""),
      createdAt: record.createdAt,
      state: record.state,
      admitted: true as const,
    };
  }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
