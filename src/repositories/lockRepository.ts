import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface ExecutionLaneHandle {
  readonly surface: string;
  readonly chatKey: string;
  readonly serviceId: string;
  readonly runId: string;
  readonly acquisitionId: string;
}

export interface LockRepositoryOptions {
  serviceId: string;
  runId: string;
  leaseMs: number;
  clock?: () => number;
}

export interface ExecutionLockRecord {
  surface: string;
  chat_key: string;
  service_id: string;
  run_id: string;
  acquisition_id: string;
  acquired_at: string;
  lease_expires_at: string;
}

export class LockRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: LockRepositoryOptions,
  ) {
    this.now = options.clock ?? Date.now;
  }

  acquire(surface: string, chatKey: string): ExecutionLaneHandle | null {
    const now = this.now();
    const acquisitionId = randomUUID();
    const acquiredAt = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + this.options.leaseMs).toISOString();
    const { changes } = this.db.prepare(`
      INSERT INTO execution_locks (surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (surface, chat_key) DO UPDATE SET
        service_id = excluded.service_id,
        run_id = excluded.run_id,
        acquisition_id = excluded.acquisition_id,
        acquired_at = excluded.acquired_at,
        lease_expires_at = excluded.lease_expires_at
      WHERE execution_locks.lease_expires_at <= excluded.acquired_at
    `).run(surface, chatKey, this.options.serviceId, this.options.runId, acquisitionId, acquiredAt, leaseExpiresAt);
    return changes === 1 ? Object.freeze({
      surface, chatKey, serviceId: this.options.serviceId, runId: this.options.runId, acquisitionId,
    }) : null;
  }

  heartbeat(handle: ExecutionLaneHandle): boolean {
    if (!this.belongsToRun(handle)) return false;
    const leaseExpiresAt = new Date(this.now() + this.options.leaseMs).toISOString();
    const { changes } = this.db.prepare(`
      UPDATE execution_locks
      SET lease_expires_at = ?
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
    `).run(leaseExpiresAt, handle.surface, handle.chatKey, handle.serviceId, handle.runId, handle.acquisitionId);
    return changes === 1;
  }

  owns(handle: ExecutionLaneHandle): boolean {
    if (!this.belongsToRun(handle)) return false;
    return !!this.db.prepare(`
      SELECT 1 FROM execution_locks
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
    `).get(handle.surface, handle.chatKey, handle.serviceId, handle.runId, handle.acquisitionId);
  }

  get runId(): string {
    return this.options.runId;
  }

  get serviceId(): string {
    return this.options.serviceId;
  }

  hasRunLock(runId: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM execution_locks WHERE run_id = ? LIMIT 1
    `).get(runId);
  }

  hasChatLock(chatKey: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM execution_locks WHERE chat_key = ? LIMIT 1`).get(chatKey);
  }

  listLocks(): ExecutionLockRecord[] {
    return this.db.prepare(`
      SELECT surface, chat_key, service_id, run_id, acquisition_id, acquired_at, lease_expires_at
      FROM execution_locks ORDER BY surface, chat_key
    `).all() as ExecutionLockRecord[];
  }

  releaseExact(record: ExecutionLockRecord): boolean {
    return this.db.prepare(`
      DELETE FROM execution_locks
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
    `).run(record.surface, record.chat_key, record.service_id, record.run_id, record.acquisition_id).changes === 1;
  }

  unlock(handle: ExecutionLaneHandle): boolean {
    if (!this.belongsToRun(handle)) return false;
    return this.db.prepare(`
      DELETE FROM execution_locks
      WHERE surface = ? AND chat_key = ? AND service_id = ? AND run_id = ? AND acquisition_id = ?
    `).run(handle.surface, handle.chatKey, handle.serviceId, handle.runId, handle.acquisitionId).changes === 1;
  }

  private belongsToRun(handle: ExecutionLaneHandle): boolean {
    return handle.serviceId === this.options.serviceId && handle.runId === this.options.runId;
  }
}
