/** Lifecycle ownership rules shared by rollout evidence and reconciliation. */

export type LifecycleClassification = "live-correlated" | "stale-unowned" | "ambiguous";

export interface LifecycleRun {
  run_id: string;
}

export interface LifecycleLock {
  surface: string;
  chat_key: string;
  run_id: string;
  service_id: string;
  acquisition_id: string;
  lease_expires_at: string;
}

export interface LifecycleClaim {
  surface?: string | null;
  chat_key?: string | null;
  state?: string | null;
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

export function correlateLegacyProcess(input: {
  processRunId: string;
  runId: string;
  lock: LifecycleLock | null;
  expectedServiceId: string;
  processInServiceCgroup: boolean;
}): LifecycleProcess {
  if (!input.lock || input.processRunId !== input.runId || input.lock.run_id !== input.runId
      || input.lock.service_id !== input.expectedServiceId || !input.processInServiceCgroup) {
    return { state: "ambiguous", run_id: input.processRunId };
  }
  return {
    state: "live",
    run_id: input.runId,
    service_id: input.lock.service_id,
    acquisition_id: input.lock.acquisition_id,
  };
}

export function claimMatchesRun(runId: string, locks: LifecycleLock[], claim: LifecycleClaim): boolean {
  const owned = claim.state === "claimed" || claim.run_id != null || claim.acquisition_id != null;
  if (!owned) return false;
  return claim.run_id === runId || locks.some((lock) =>
    claim.acquisition_id === lock.acquisition_id
    || (claim.surface === lock.surface && claim.chat_key === lock.chat_key)
  );
}
