import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeEngine } from "../src/engine.js";
import { openDb } from "../src/db.js";
import { MissingRunOutcomeError, RunOutcomeReconciliationError, requestAgentBridgeOutcome } from "../src/runOutcome.js";
import { listRunContinuations } from "../src/runContinuation.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(mode: "complete-after-retry" | "continue-after-retry" | "blocked-after-retry" | "missing-twice" | "report-first" | "retry-throws") {
  const dir = mkdtempSync(join(tmpdir(), "run-outcome-engine-")); dirs.push(dir);
  const path = join(dir, "bridge.sqlite");
  const db = openDb(path, { serviceId: "outcome-engine-test", runId: "process" });
  const identity = { surfaceIdentity: "telegram:interactive", chatKey: "chat" };
  db.insertRun("run-one", identity, "claude");
  const handle = db.acquireLock(identity.surfaceIdentity, identity.chatKey);
  if (!handle) throw new Error("missing fixture lane ownership");
  let calls = 0;
  const invocation = vi.fn(async (_provider: unknown, _invocation: unknown, _cwd: unknown, options: any, request: any) => {
    calls += 1;
    if (mode === "retry-throws" && calls === 2) throw new Error("provider quota exhausted after initial work");
    if (mode === "report-first" || (mode === "complete-after-retry" && calls === 2)) {
      requestAgentBridgeOutcome(["complete", "--evidence", "verified"], options.contextEnv);
    }
    if (mode === "continue-after-retry" && calls === 2) {
      requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "CI pending, finish merge"], options.contextEnv);
    }
    if (mode === "blocked-after-retry" && calls === 2) {
      requestAgentBridgeOutcome(["blocked", "--reason", "Owner approval required"], options.contextEnv);
    }
    return {
      text: calls === 1 ? "Original user-facing answer" : "Reconciliation was recorded",
      sessionId: "same-acp-session",
      stopReason: "end_turn",
    };
  });
  const engine = new BridgeEngine({
    surfaceIdentity: identity.surfaceIdentity,
    kind: "claude",
    botConfig: { command: "claude", modelPreference: [] },
    allowedUserIds: new Set(["42"]),
    executionMode: "safe",
    pollIntervalMs: 1000,
    workingDir: dir,
    fullConfig: { dbPath: path } as any,
  }, db, {} as any, { runProviderInvocation: invocation } as any);
  return { db, engine, handle, invocation };
}

describe("ordinary Run objective settlement", () => {
  it("performs one same-session reconciliation without losing the original answer", async () => {
    const { db, engine, handle, invocation } = fixture("complete-after-retry");
    const result = await engine.executePromptAsync(
      "Fix and verify", null, "chat", {}, () => {}, [],
      undefined, "run-one", null, "chat", handle,
    );
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(invocation.mock.calls[1][4].sessionId).toBe("same-acp-session");
    expect(invocation.mock.calls[1][4].outputDir).toBe(invocation.mock.calls[0][4].outputDir);
    expect(result.text).toBe("Reconciliation was recorded");
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    db.close();
  });

  it("schedules unfinished work after one missing-outcome reconciliation", async () => {
    const { db, engine, handle, invocation } = fixture("continue-after-retry");
    const result = await engine.executePromptAsync("Ship both PRs", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(db.getRun("run-one").outcome_status).toBe("continue");
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({
      originRunId: "run-one", state: "pending", reason: "CI pending, finish merge",
    })]);
    expect(result.text).toBe("Reconciliation was recorded");
    db.close();
  });

  it("keeps a genuine blocker terminal after one missing-outcome reconciliation", async () => {
    const { db, engine, handle, invocation } = fixture("blocked-after-retry");
    const result = await engine.executePromptAsync("Deploy", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(db.getRun("run-one").outcome_status).toBe("blocked");
    expect(listRunContinuations(db)).toHaveLength(0);
    expect(result.text).toBe("Reconciliation was recorded");
    db.close();
  });

  it("does not retry after a present complete outcome", async () => {
    const { db, engine, handle, invocation } = fixture("report-first");
    const result = await engine.executePromptAsync("Answer", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("Original user-facing answer");
    db.close();
  });

  it("fails as unresolved after exactly one unsuccessful reconciliation", async () => {
    const { db, engine, handle, invocation } = fixture("missing-twice");
    await expect(engine.executePromptAsync("Fix", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle))
      .rejects.toBeInstanceOf(MissingRunOutcomeError);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(db.getRun("run-one").outcome_status).toBeNull();
    db.close();
  });
  it("never falls back to replaying the original work if the reconciliation provider fails", async () => {
    const { db, engine, handle, invocation } = fixture("retry-throws");
    await expect(engine.executePromptAsync("Ship and deploy", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle))
      .rejects.toBeInstanceOf(RunOutcomeReconciliationError);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(invocation.mock.calls[1][4].sessionId).toBe("same-acp-session");
    db.close();
  });

});
