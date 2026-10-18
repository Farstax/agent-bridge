import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export interface ExecutionCapacityClaim {
  readonly claimId: string;
  readonly serviceId: string;
  readonly runId: string;
  readonly acquisitionId: string;
  readonly executionId: string;
}

export interface ExecutionCapacityRepositoryOptions {
  serviceId: string;
  runId: string;
  leaseMs: number;
  clock?: () => number;
}

/** Atomic global provider-capacity admission over one existing SQLite DB. */
export class ExecutionCapacityRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: ExecutionCapacityRepositoryOptions,
  ) {
    this.now = options.clock ?? Date.now;
  }

  acquire(limit: number, executionId: string, acquisitionId: string): ExecutionCapacityClaim | null {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("execution capacity limit must be a positive integer");
    const now = this.now();
    const acquiredAt = new Date(now).toISOString();
    const claim: ExecutionCapacityClaim = Object.freeze({
      claimId: randomUUID(),
      serviceId: this.options.serviceId,
      runId: this.options.runId,
      acquisitionId,
      executionId,
    });
    return this.db.transaction(() => {
      // Expiry is the existing durable execution-fence boundary. The owning
      // invocation renews this claim while it is live; a process that loses
      // that fence must not retain capacity.
      this.db.prepare("DELETE FROM execution_capacity_claims WHERE lease_expires_at <= ?").run(acquiredAt);
      const active = this.db.prepare("SELECT COUNT(*) AS n FROM execution_capacity_claims").get() as { n: number };
      if (active.n >= limit) return null;
      this.db.prepare(`
        INSERT INTO execution_capacity_claims
          (claim_id, service_id, run_id, acquisition_id, execution_id, acquired_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        claim.claimId, claim.serviceId, claim.runId, claim.acquisitionId, claim.executionId,
        acquiredAt, new Date(now + this.options.leaseMs).toISOString(),
      );
      return claim;
    })();
  }

  heartbeat(claim: ExecutionCapacityClaim): boolean {
    if (claim.serviceId !== this.options.serviceId || claim.runId !== this.options.runId) return false;
    return this.db.prepare(`
      UPDATE execution_capacity_claims SET lease_expires_at = ?
      WHERE claim_id = ? AND service_id = ? AND run_id = ? AND acquisition_id = ? AND execution_id = ?
    `).run(
      new Date(this.now() + this.options.leaseMs).toISOString(),
      claim.claimId, claim.serviceId, claim.runId, claim.acquisitionId, claim.executionId,
    ).changes === 1;
  }

  release(claim: ExecutionCapacityClaim): boolean {
    if (claim.serviceId !== this.options.serviceId || claim.runId !== this.options.runId) return false;
    return this.db.prepare(`
      DELETE FROM execution_capacity_claims
      WHERE claim_id = ? AND service_id = ? AND run_id = ? AND acquisition_id = ? AND execution_id = ?
    `).run(claim.claimId, claim.serviceId, claim.runId, claim.acquisitionId, claim.executionId).changes === 1;
  }

  count(): number {
    const now = new Date(this.now()).toISOString();
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM execution_capacity_claims WHERE lease_expires_at <= ?").run(now);
      return (this.db.prepare("SELECT COUNT(*) AS n FROM execution_capacity_claims").get() as { n: number }).n;
    })();
  }
}
