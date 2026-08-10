import { execFileSync } from "node:child_process";

const RUN_MARKER_ENV = "AGENT_BRIDGE_RUN_ID";
const PROCESS_POLL_MS = 25;
const FINAL_KILL_POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listRunOwnedPids(runId: string, excludePid = process.pid): number[] {
  if (!runId) return [];
  let processTable: string;
  try {
    processTable = execFileSync("/usr/bin/ps", ["eww", "-eo", "pid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return [];
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

export function hasLiveRunOwnedDescendants(runId: string, excludePid = process.pid): boolean {
  return listRunOwnedPids(runId, excludePid).length > 0;
}

function signalRunOwned(runId: string, signal: NodeJS.Signals, excludePid = process.pid): void {
  for (const pid of listRunOwnedPids(runId, excludePid)) {
    try { process.kill(pid, signal); } catch { /* process may have exited between scan and signal */ }
  }
}

export async function killRunOwnedDescendants(
  runId: string,
  graceMs = 5_000,
  excludePid = process.pid,
): Promise<void> {
  if (!runId || !hasLiveRunOwnedDescendants(runId, excludePid)) return;

  signalRunOwned(runId, "SIGTERM", excludePid);
  const graceDeadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < graceDeadline) {
    if (!hasLiveRunOwnedDescendants(runId, excludePid)) return;
    await sleep(PROCESS_POLL_MS);
  }

  signalRunOwned(runId, "SIGKILL", excludePid);
  const finalDeadline = Date.now() + FINAL_KILL_POLL_MS;
  while (Date.now() < finalDeadline) {
    if (!hasLiveRunOwnedDescendants(runId, excludePid)) return;
    await sleep(PROCESS_POLL_MS);
  }
}
