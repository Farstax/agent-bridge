/** Lifecycle ownership rules shared by rollout evidence and reconciliation. */

export type LifecycleClassification = "live-correlated" | "stale-unowned" | "ambiguous";

export interface LifecycleRun {
  run_id: string;
}

export interface LifecycleLock {
  run_id: string;
  service_id: string;
  acquisition_id: string;
  lease_expires_at: string;
}

export interface LifecycleClaim {
  run_id?: string | null;
  acquisition_id?: string | null;
}

export type LifecycleProcess =
  | { state: "live"; run_id: string; service_id: string; acquisition_id: string }
  | { state: "absent"; run_id: string }
  | { state: "ambiguous"; run_id?: string };

export function classifyLifecycleState(input: {
  nowMs: number;
  run: LifecycleRun;
  locks: LifecycleLock[];
  claims: LifecycleClaim[];
  process: LifecycleProcess;
}): LifecycleClassification {
  const { run, locks, claims, process } = input;
  if (claims.length > 0 || process.state === "ambiguous") return "ambiguous";
  if (locks.some((candidate) => candidate.run_id !== run.run_id)) return "ambiguous";
  if (process.state === "absent") return locks.length <= 1 ? "stale-unowned" : "ambiguous";
  if (process.run_id !== run.run_id || locks.length !== 1) return "ambiguous";
  const candidate = locks[0];
  if (candidate.service_id !== process.service_id || candidate.acquisition_id !== process.acquisition_id) return "ambiguous";
  if (new Date(candidate.lease_expires_at).getTime() <= input.nowMs) return "ambiguous";
  return "live-correlated";
}
