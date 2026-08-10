import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasLiveRunOwnedDescendants,
  killRunOwnedDescendants,
} from "../src/cli.js";

const children = new Set<ChildProcess>();

function spawnMarked(runId: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    env: { ...process.env, AGENT_BRIDGE_RUN_ID: runId },
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for process state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  for (const child of children) {
    try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch {}
    try { child.kill("SIGKILL"); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  children.clear();
});

describe("run-owned continuation processes", () => {
  it("detects only processes carrying the exact per-turn run marker", async () => {
    const runId = `continuation-live-${Date.now()}-${Math.random()}`;
    spawnMarked(runId);
    await waitUntil(() => hasLiveRunOwnedDescendants(runId));

    expect(hasLiveRunOwnedDescendants(runId)).toBe(true);
    expect(hasLiveRunOwnedDescendants(`${runId}-other`)).toBe(false);
  });

  it("terminates residual marked processes without killing another run", async () => {
    const runId = `continuation-kill-${Date.now()}-${Math.random()}`;
    const otherRunId = `${runId}-other`;
    spawnMarked(runId);
    spawnMarked(otherRunId);
    await waitUntil(() => hasLiveRunOwnedDescendants(runId) && hasLiveRunOwnedDescendants(otherRunId));

    await killRunOwnedDescendants(runId, 50);

    expect(hasLiveRunOwnedDescendants(runId)).toBe(false);
    expect(hasLiveRunOwnedDescendants(otherRunId)).toBe(true);
  });
});
