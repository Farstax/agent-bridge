import { execFileSync } from "node:child_process";

const RUN_MARKER_ENV = "AGENT_BRIDGE_RUN_ID";
const PROCESS_POLL_MS = 25;
const FINAL_KILL_POLL_MS = 1_000;

export type RunOwnedProcessState = "live" | "absent" | "ambiguous";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listRunOwnedPids(runId: string, excludePid = process.pid): number[] | null {
  if (!runId) return [];
  let processTable: string;
  try {
    processTable = execFileSync("/usr/bin/ps", ["eww", "-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }

  const marker = `${RUN_MARKER_ENV}=${runId}`;
  const pids: number[] = [];
  for (const line of processTable.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === excludePid) continue;
    const fields = match[2].split(/\s+/);
    if (fields.includes(marker)) pids.push(pid);
  }
  return pids;
}

export function getRunOwnedProcessState(runId: string, excludePid = process.pid): RunOwnedProcessState {
  const pids = listRunOwnedPids(runId, excludePid);
  if (pids === null) return "ambiguous";
  return pids.length > 0 ? "live" : "absent";
}

export function hasLiveRunOwnedDescendants(runId: string, excludePid = process.pid): boolean {
  return getRunOwnedProcessState(runId, excludePid) === "live";
}

function signalRunOwned(runId: string, signal: NodeJS.Signals, excludePid = process.pid): void {
  const pids = listRunOwnedPids(runId, excludePid);
  if (!pids) return;
  for (const pid of pids) {
    try { process.kill(pid, signal); } catch { /* process may have exited between scan and signal */ }
  }
}

export async function killRunOwnedDescendants(
  runId: string,
  graceMs = 5_000,
  excludePid = process.pid,
): Promise<void> {
  if (!runId || getRunOwnedProcessState(runId, excludePid) !== "live") return;

  signalRunOwned(runId, "SIGTERM", excludePid);
  const graceDeadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < graceDeadline) {
    if (getRunOwnedProcessState(runId, excludePid) !== "live") return;
    await sleep(PROCESS_POLL_MS);
  }

  signalRunOwned(runId, "SIGKILL", excludePid);
  const finalDeadline = Date.now() + FINAL_KILL_POLL_MS;
  while (Date.now() < finalDeadline) {
    if (getRunOwnedProcessState(runId, excludePid) !== "live") return;
    await sleep(PROCESS_POLL_MS);
  }
}