import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { runEventOwnedTurn, EventRunLaneUnavailableError } from "../src/eventOwnedRun.js";

/**
 * Issue #351: covers the one new primitive added for event-originated
 * execution — running a single bounded CLI turn correlated to an ordinary
 * bridge_runs row, fenced by the same execution_locks lane BridgeEngine
 * itself uses, without any Telegram chat/session/continuation machinery.
 */

function makeDb() {
  const dbPath = join(tmpdir(), `event-owned-run-test-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-service", runId: "test-process" });
  return { db, dbPath };
}

describe("runEventOwnedTurn", () => {
  let db: ReturnType<typeof openDb>;
  let dbPath: string;

  beforeEach(() => {
    ({ db, dbPath } = makeDb());
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("creates a running bridge_runs row, invokes the CLI, and records completion", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const fakeRunCli = async (command: string, args: string[], cwd: string) => {
      calls.push({ command, args, cwd });
      return JSON.stringify({ result: "diagnostic complete", session_id: null });
    };

    const outcome = await runEventOwnedTurn(
      db,
      { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "investigate" },
      { runCli: fakeRunCli, runId: () => "run-fixed-1" },
    );

    expect(outcome.status).toBe("done");
    expect(outcome.runId).toBe("run-fixed-1");
    expect(calls).toHaveLength(1);

    const run = db.getRun("run-fixed-1");
    expect(run.chat_id).toBe("health:ops");
    expect(run.bot).toBe("claude");
    expect(run.status).toBe("done");
  });

  it("records failure without throwing when the CLI invocation rejects", async () => {
    const fakeRunCli = async () => { throw new Error("cli exploded"); };

    const outcome = await runEventOwnedTurn(
      db,
      { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "investigate" },
      { runCli: fakeRunCli, runId: () => "run-fixed-2" },
    );

    expect(outcome.status).toBe("failed");
    const run = db.getRun("run-fixed-2");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("cli exploded");
  });

  it("releases the execution lane after completion so a subsequent turn can acquire it", async () => {
    const fakeRunCli = async () => JSON.stringify({ result: "ok" });

    await runEventOwnedTurn(
      db,
      { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "first" },
      { runCli: fakeRunCli, runId: () => "run-first" },
    );

    const outcome = await runEventOwnedTurn(
      db,
      { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "second" },
      { runCli: fakeRunCli, runId: () => "run-second" },
    );

    expect(outcome.status).toBe("done");
  });

  it("rejects with EventRunLaneUnavailableError and does not create a Run when the lane is already held", async () => {
    // Acquire the lane out from under the primitive to simulate a
    // concurrently in-flight turn on the same synthetic chat key.
    const handle = db.acquireLock("health", "health:ops");
    expect(handle).not.toBeNull();

    const fakeRunCli = async () => JSON.stringify({ result: "should not run" });

    await expect(
      runEventOwnedTurn(
        db,
        { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "blocked" },
        { runCli: fakeRunCli, runId: () => "run-blocked" },
      ),
    ).rejects.toBeInstanceOf(EventRunLaneUnavailableError);

    expect(db.getRun("run-blocked")).toBeUndefined();
  });

  it("does not overwrite a Run that was cancelled out from under the execution (fence loss)", async () => {
    let resolveCli!: (value: string) => void;
    const cliPromise = new Promise<string>((resolve) => { resolveCli = resolve; });
    const fakeRunCli = async () => cliPromise;

    const turnPromise = runEventOwnedTurn(
      db,
      { surface: "health", chatKey: "health:ops", bot: "claude", command: "claude", model: null, prompt: "long-running" },
      { runCli: fakeRunCli, runId: () => "run-cancel-race" },
    );

    // Simulate an operator/reconciler cancelling the run mid-flight.
    expect(db.updateRunCancelled("run-cancel-race", "operator cancelled")).toBe(true);

    resolveCli(JSON.stringify({ result: "late result" }));
    const outcome = await turnPromise;

    expect(outcome.status).toBe("failed");
    const run = db.getRun("run-cancel-race");
    expect(run.status).toBe("cancelled");
    expect(run.final_text_preview).toBeNull();
  });
});
