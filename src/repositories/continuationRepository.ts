import type Database from "better-sqlite3";
import type { ExecutionLaneHandle } from "./lockRepository.js";

export type ContinuationExecutionMode = "sync" | "async";
export type ContinuationState = "waiting" | "runnable" | "running" | "completed" | "cancelled" | "ambiguous";

export interface ContinuationRecord {
  runId: string;
  surface: string;
  chatKey: string;
  chatId: number;
  threadId: number | null;
  bot: string;
  sessionId: string;
  executionMode: ContinuationExecutionMode;
  triggerKind: "run-owned-background-process";
  triggerId: string;
  state: ContinuationState;
  resumptionCount: number;
  pendingIds: number[];
  startedAt: string;
  deadlineAt: string;
  updatedAt: string;
  terminalReason?: string;
}

export type SaveWaitingContinuation = Omit<
  ContinuationRecord,
  "state" | "updatedAt" | "terminalReason"
>;

const KEY_PREFIX = "turn_continuation:";
const ACTIVE_STATES = new Set<ContinuationState>(["waiting", "runnable", "running", "ambiguous"]);

function key(runId: string): string {
  return `${KEY_PREFIX}${runId}`;
}

function parseRecord(value: unknown): ContinuationRecord | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ContinuationRecord>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.runId !== "string" || typeof parsed.surface !== "string" || typeof parsed.chatKey !== "string") return null;
    if (typeof parsed.chatId !== "number" || !Number.isFinite(parsed.chatId)) return null;
    if (parsed.threadId !== null && typeof parsed.threadId !== "number") return null;
    if (typeof parsed.bot !== "string" || typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
    if (parsed.executionMode !== "sync" && parsed.executionMode !== "async") return null;
    if (parsed.triggerKind !== "run-owned-background-process" || typeof parsed.triggerId !== "string") return null;
    if (!["waiting", "runnable", "running", "completed", "cancelled", "ambiguous"].includes(String(parsed.state))) return null;
    if (!Number.isInteger(parsed.resumptionCount) || Number(parsed.resumptionCount) < 0) return null;
    if (!Array.isArray(parsed.pendingIds) || parsed.pendingIds.some((id) => !Number.isInteger(id) || id <= 0)) return null;
    if (typeof parsed.startedAt !== "string" || typeof parsed.deadlineAt !== "string" || typeof parsed.updatedAt !== "string") return null;
    return parsed as ContinuationRecord;
  } catch {
    return null;
  }
}

export class ContinuationRepository {
  constructor(private readonly db: Database.Database) {}

  get(runId: string): ContinuationRecord | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key(runId)) as { value?: string | null } | undefined;
    return parseRecord(row?.value ?? null);
  }

  listActive(surface?: string, bot?: string): ContinuationRecord[] {
    const rows = this.db.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key").all(`${KEY_PREFIX}%`) as Array<{ value?: string | null }>;
    return rows
      .map((row) => parseRecord(row.value ?? null))
      .filter((record): record is ContinuationRecord => !!record)
      .filter((record) => ACTIVE_STATES.has(record.state))
      .filter((record) => surface == null || record.surface === surface)
      .filter((record) => bot == null || record.bot === bot);
  }

  hasActiveRun(runId: string): boolean {
    const record = this.get(runId);
    return !!record && ACTIVE_STATES.has(record.state);
  }

  saveWaiting(input: SaveWaitingContinuation): ContinuationRecord {
    const record: ContinuationRecord = {
      ...input,
      state: "waiting",
      updatedAt: new Date().toISOString(),
    };
    this.write(record);
    return record;
  }

  markRunnable(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting"]), (record) => ({
      ...record,
      state: "runnable",
      updatedAt: new Date().toISOString(),
    }));
  }

  claimRunnable(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["runnable"]), (record) => ({
      ...record,
      state: "running",
      resumptionCount: record.resumptionCount + 1,
      updatedAt: new Date().toISOString(),
    }));
  }

  markCompleted(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting", "runnable", "running"]), (record) => ({
      ...record,
      state: "completed",
      updatedAt: new Date().toISOString(),
      terminalReason: undefined,
    }));
  }

  markCancelled(runId: string, reason = "cancelled"): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting", "runnable", "running", "ambiguous"]), (record) => ({
      ...record,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
      terminalReason: reason,
    }));
  }

  markAmbiguous(runId: string, reason: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting", "runnable", "running", "ambiguous"]), (record) => ({
      ...record,
      state: "ambiguous",
      updatedAt: new Date().toISOString(),
      terminalReason: reason,
    }));
  }

  cancelActiveForLane(surface: string, chatKey: string, reason: string): ContinuationRecord[] {
    const cancelled: ContinuationRecord[] = [];
    for (const record of this.listActive(surface)) {
      if (record.chatKey !== chatKey) continue;
      const next = this.markCancelled(record.runId, reason);
      if (next) cancelled.push(next);
    }
    return cancelled;
  }

  reclaimPendingIds(handle: ExecutionLaneHandle, pendingIds: number[]): boolean {
    if (pendingIds.length === 0) return true;
    return this.db.transaction(() => {
      const owns = this.db.prepare(`
        SELECT 1 FROM execution_locks
        WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
      `).get(handle.surface, handle.chatKey, handle.serviceId, handle.runId, handle.acquisitionId);
      if (!owns) return false;
      const claim = this.db.prepare(`
        UPDATE pending_messages
        SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?, claimed_at = ?
        WHERE id = ? AND surface = ? AND chat_key = ? AND state IN ('queued', 'claimed')
      `);
      const claimedAt = new Date().toISOString();
      for (const id of pendingIds) {
        if (claim.run(handle.runId, handle.acquisitionId, claimedAt, id, handle.surface, handle.chatKey).changes !== 1) return false;
      }
      return true;
    })();
  }

  private transition(
    runId: string,
    allowedStates: ReadonlySet<ContinuationState>,
    update: (record: ContinuationRecord) => ContinuationRecord,
  ): ContinuationRecord | null {
    return this.db.transaction(() => {
      const currentRow = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key(runId)) as { value?: string | null } | undefined;
      const currentText = currentRow?.value ?? null;
      const current = parseRecord(currentText);
      if (!current || !allowedStates.has(current.state) || currentText == null) return null;
      const next = update(current);
      const nextText = JSON.stringify(next);
      const changed = this.db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .run(nextText, key(runId), currentText).changes;
      return changed === 1 ? next : null;
    })();
  }

  private write(record: ContinuationRecord): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key(record.runId), JSON.stringify(record));
  }
}
