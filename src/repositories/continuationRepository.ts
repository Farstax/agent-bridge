import type Database from "better-sqlite3";
import type { ProjectMemoryCandidate } from "../projectMemory.js";
import type { ExecutionLaneHandle } from "./lockRepository.js";

export type ContinuationExecutionMode = "sync" | "async";
export type ContinuationState = "waiting" | "runnable" | "running" | "completed" | "cancelled" | "ambiguous";
export type ContinuationDeliveryState = "pending" | "delivered" | "none";

export interface ContinuationAttemptCheckpoint {
  prompt: string;
  isInitialResult: boolean;
  result: {
    text: string;
    sessionId: string | null;
    memoryCandidates: ProjectMemoryCandidate[];
    continuationHint?: "background-process";
    continuationProcessObserved?: boolean;
  };
}

export interface ContinuationRecord {
  runId: string;
  surface: string;
  chatKey: string;
  chatId: number;
  threadId: number | null;
  bot: string;
  sessionId: string;
  /** Original admitted prompt used only when responsibility moves providers. */
  prompt?: string;
  chatType?: string;
  userId?: number | null;
  attachments?: string[];
  executionMode: ContinuationExecutionMode;
  triggerKind: "run-owned-background-process";
  triggerId: string;
  state: ContinuationState;
  resumptionCount: number;
  pendingIds: number[];
  startedAt: string;
  deadlineAt: string;
  deliveryState: ContinuationDeliveryState;
  pendingAttempt?: ContinuationAttemptCheckpoint;
  updatedAt: string;
  terminalReason?: string;
  containedAt?: string;
}

export type SaveWaitingContinuation = Omit<
  ContinuationRecord,
  "state" | "updatedAt" | "terminalReason" | "containedAt" | "deliveryState" | "pendingAttempt"
> & Partial<Pick<ContinuationRecord, "deliveryState" | "pendingAttempt">>;

const KEY_PREFIX = "turn_continuation:";
const ACTIVE_STATES = new Set<ContinuationState>(["waiting", "runnable", "running", "ambiguous"]);

function key(runId: string): string {
  return `${KEY_PREFIX}${runId}`;
}

function needsOrphanProtection(record: ContinuationRecord): boolean {
  return ACTIVE_STATES.has(record.state) || (record.state === "cancelled" && !record.containedAt);
}

function parsePendingAttempt(value: unknown): ContinuationAttemptCheckpoint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attempt = value as Partial<ContinuationAttemptCheckpoint>;
  if (typeof attempt.prompt !== "string" || typeof attempt.isInitialResult !== "boolean") return undefined;
  if (!attempt.result || typeof attempt.result !== "object" || Array.isArray(attempt.result)) return undefined;
  const result = attempt.result as Partial<ContinuationAttemptCheckpoint["result"]>;
  if (typeof result.text !== "string") return undefined;
  if (result.sessionId !== null && typeof result.sessionId !== "string") return undefined;
  if (!Array.isArray(result.memoryCandidates)) return undefined;
  if (result.continuationHint !== undefined && result.continuationHint !== "background-process") return undefined;
  if (result.continuationProcessObserved !== undefined && typeof result.continuationProcessObserved !== "boolean") return undefined;
  return attempt as ContinuationAttemptCheckpoint;
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
    if (parsed.containedAt !== undefined && typeof parsed.containedAt !== "string") return null;
    const deliveryState = parsed.deliveryState ?? "delivered";
    if (deliveryState !== "pending" && deliveryState !== "delivered" && deliveryState !== "none") return null;
    const pendingAttempt = parsePendingAttempt(parsed.pendingAttempt);
    if (deliveryState === "pending" && !pendingAttempt) return null;
    const attachments = Array.isArray(parsed.attachments)
      ? parsed.attachments.filter((attachment): attachment is string => typeof attachment === "string")
      : [];
    return { ...parsed, deliveryState, pendingAttempt, attachments } as ContinuationRecord;
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
    return this.listRecords()
      .filter((record) => ACTIVE_STATES.has(record.state))
      .filter((record) => surface == null || record.surface === surface)
      .filter((record) => bot == null || record.bot === bot);
  }

  listUncontainedCancelled(): ContinuationRecord[] {
    return this.listRecords().filter((record) => record.state === "cancelled" && !record.containedAt);
  }

  hasActiveRun(runId: string): boolean {
    const record = this.get(runId);
    return !!record && needsOrphanProtection(record);
  }

  hasActiveForLane(surface: string, chatKey: string): boolean {
    return this.listActive(surface).some((record) => record.chatKey === chatKey);
  }

  saveWaiting(input: SaveWaitingContinuation): ContinuationRecord | null {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key(input.runId)) as { value?: string | null } | undefined;
      const currentText = row?.value ?? null;
      const current = parseRecord(currentText);
      // A cancellation/failure that raced the checkpoint wins permanently.
      // The only valid re-checkpoint is a claimed continuation attempt moving
      // back from running to waiting (or an idempotent waiting rewrite).
      if (current && current.state !== "running" && current.state !== "waiting") return null;

      const record: ContinuationRecord = {
        ...input,
        prompt: current?.prompt ?? input.prompt,
        chatType: current?.chatType ?? input.chatType,
        userId: current?.userId ?? input.userId,
        attachments: current?.attachments ?? input.attachments ?? [],
        deliveryState: input.deliveryState ?? "delivered",
        state: "waiting",
        updatedAt: new Date().toISOString(),
      };
      if (record.deliveryState === "pending" && !record.pendingAttempt) return null;
      const nextText = JSON.stringify(record);
      if (currentText == null) {
        this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key(record.runId), nextText);
        return record;
      }
      const changed = this.db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .run(nextText, key(record.runId), currentText).changes;
      return changed === 1 ? record : null;
    })();
  }

  markRunnable(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting"]), (record) => ({
      ...record,
      state: "runnable",
      updatedAt: new Date().toISOString(),
    }));
  }

  markDeliveryCommitted(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting"]), (record) => {
      if (record.deliveryState !== "pending") return record;
      return {
        ...record,
        deliveryState: "delivered",
        pendingAttempt: undefined,
        updatedAt: new Date().toISOString(),
      };
    }, (record) => record.deliveryState === "pending");
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
      containedAt: undefined,
    }));
  }

  markCancelled(runId: string, reason = "cancelled"): ContinuationRecord | null {
    return this.transition(runId, new Set(["waiting", "runnable", "running", "ambiguous"]), (record) => ({
      ...record,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
      terminalReason: reason,
      containedAt: undefined,
    }));
  }

  markCancellationContained(runId: string): ContinuationRecord | null {
    return this.transition(runId, new Set(["cancelled"]), (record) => ({
      ...record,
      updatedAt: new Date().toISOString(),
      containedAt: new Date().toISOString(),
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

  private listRecords(): ContinuationRecord[] {
    const rows = this.db.prepare("SELECT value FROM settings WHERE key LIKE ? ORDER BY key").all(`${KEY_PREFIX}%`) as Array<{ value?: string | null }>;
    return rows
      .map((row) => parseRecord(row.value ?? null))
      .filter((record): record is ContinuationRecord => !!record);
  }

  private transition(
    runId: string,
    allowedStates: ReadonlySet<ContinuationState>,
    update: (record: ContinuationRecord) => ContinuationRecord,
    guard: (record: ContinuationRecord) => boolean = () => true,
  ): ContinuationRecord | null {
    return this.db.transaction(() => {
      const currentRow = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key(runId)) as { value?: string | null } | undefined;
      const currentText = currentRow?.value ?? null;
      const current = parseRecord(currentText);
      if (!current || !allowedStates.has(current.state) || currentText == null || !guard(current)) return null;
      const next = update(current);
      const nextText = JSON.stringify(next);
      const changed = this.db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?")
        .run(nextText, key(runId), currentText).changes;
      return changed === 1 ? next : null;
    })();
  }
}
