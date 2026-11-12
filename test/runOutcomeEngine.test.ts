import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeEngine } from "../src/engine.js";
import { openDb } from "../src/db.js";
import { MissingRunOutcomeError, RunOutcomeReconciliationError, requestAgentBridgeOutcome } from "../src/runOutcome.js";
import { listRunContinuations, RUN_CONTINUATION_PREFIX } from "../src/runContinuation.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(mode: "complete-after-retry" | "continue-after-retry" | "blocked-after-retry" | "missing-twice" | "report-first" | "report-continue" | "continue-no-wake" | "continue-cancelled-wake" | "continue-mismatched-wake" | "continue-mismatched-binding" | "retry-throws" | "refusal" | "continue-then-invalid-session" | "continue-then-model-fallback" | "continue-then-internal-retry", surfaceIdentity = "telegram:interactive") {
  const dir = mkdtempSync(join(tmpdir(), "run-outcome-engine-")); dirs.push(dir);
  const path = join(dir, "bridge.sqlite");
  const db = openDb(path, { serviceId: "outcome-engine-test", runId: "process" });
  const identity = { surfaceIdentity, chatKey: "chat" };
  const provider = mode === "continue-then-model-fallback" ? "codex" : "claude";
  db.insertRun("run-one", identity, provider);
  const handle = db.acquireLock(identity.surfaceIdentity, identity.chatKey);
  if (!handle) throw new Error("missing fixture lane ownership");
  let calls = 0;
  const invocation = vi.fn(async (_provider: unknown, _invocation: unknown, _cwd: unknown, options: any, request: any) => {
    calls += 1;
    if (mode === "retry-throws" && calls === 2) throw new Error("provider quota exhausted after initial work");
    if (mode === "continue-then-invalid-session" && calls === 1) {
      requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "stale wake"], options.contextEnv);
      throw new Error("No conversation found with session ID: stale-session");
    }
    if (mode === "continue-then-model-fallback" && calls === 1) {
      requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "stale model wake"], options.contextEnv);
      throw new Error("usage limit reached");
    }
    if (mode === "continue-then-internal-retry") {
      requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "stale internal wake"], options.contextEnv);
      await options.onProviderRetry();
    }
    if (mode === "report-first" || (mode === "complete-after-retry" && calls === 2) || (mode === "continue-then-invalid-session" && calls === 2) || (mode === "continue-then-model-fallback" && calls === 2) || mode === "continue-then-internal-retry") {
      requestAgentBridgeOutcome(["complete", "--evidence", "verified"], options.contextEnv);
    }
    if (mode === "report-continue" || mode === "continue-no-wake" || mode === "continue-cancelled-wake" || mode === "continue-mismatched-wake" || mode === "continue-mismatched-binding") {
      requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "finish pending verification"], options.contextEnv);
      const key = `${RUN_CONTINUATION_PREFIX}run-one`;
      if (mode === "continue-no-wake") {
        db.raw.prepare("DELETE FROM settings WHERE key = ?").run(key);
      } else if (mode !== "report-continue") {
        const row = db.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string };
        const existing = JSON.parse(row.value) as Record<string, unknown>;
        const changed = mode === "continue-cancelled-wake"
          ? { ...existing, state: "cancelled" }
          : mode === "continue-mismatched-binding"
            ? { ...existing, outwardSessionId: "wrong-ws" }
            : { ...existing, chatKey: "some-other-workstream" };
        db.raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(changed), key);
      }
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
      stopReason: mode === "refusal" ? "refusal" : "end_turn",
      telemetry: { provider: "claude", inputTokens: calls === 1 ? 100 : 20, outputTokens: calls === 1 ? 30 : 5 },
    };
  });
  const engine = new BridgeEngine({
    surfaceIdentity: identity.surfaceIdentity,
    kind: provider,
    botConfig: { command: provider, modelPreference: mode === "continue-then-model-fallback" ? ["primary", "fallback"] : [] },
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
    expect(result.telemetry).toEqual(expect.objectContaining({ inputTokens: 120, outputTokens: 35 }));
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    db.close();
  });

  it("reconciles eligible neutral Run outcomes even when messaging artifact delivery is disabled", async () => {
    const { db, engine, handle, invocation } = fixture("complete-after-retry");
    const result = await engine.executePromptAsync(
      "Complete the original task", null, "chat",
      { publishArtifacts: false, onOutputArtifacts: async () => ({ retained: 0, discarded: 0 }) },
      () => {}, [], undefined, "run-one", null, "chat", handle,
    );
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Reconciliation was recorded");
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    db.close();
  });

  it("exposes the existing outcome/wait helpers only to authorised ordinary Desk Runs", async () => {
    // This is the actual outward ACP pipeline: it does not supply the optional
    // generated-artifact callback, but opted-in Runs still require outcomes.
    const options = { publishArtifacts: false };
    const eligible = fixture("continue-after-retry", "acp:outward");
    const result = await eligible.engine.executePromptAsync(
      "Continue verified work", null, "chat",
      { ...options, ordinaryWorkstreamId: "ws-trusted" },
      () => {}, [], undefined, "run-one", null, "chat", eligible.handle,
    );
    expect(result.text).toBe("Reconciliation was recorded");
    expect(eligible.invocation).toHaveBeenCalledTimes(2);
    expect(eligible.invocation.mock.calls[0][3].contextEnv).toMatchObject({
      AGENT_BRIDGE_OUTCOME_COMMAND: expect.any(String),
      AGENT_BRIDGE_WAIT_COMMAND: expect.any(String),
      AGENT_BRIDGE_OUTWARD_SESSION_ID: "ws-trusted",
    });
    expect(eligible.db.getRun("run-one").outcome_status).toBe("continue");
    expect(listRunContinuations(eligible.db, "acp:outward")).toEqual([
      expect.objectContaining({ outwardSessionId: "ws-trusted", state: "pending" }),
    ]);
    eligible.db.close();

    const legacy = fixture("missing-twice", "acp:outward");
    await legacy.engine.executePromptAsync(
      "Legacy ACP response", null, "chat", options,
      () => {}, [], undefined, "run-one", null, "chat", legacy.handle,
    );
    expect(legacy.invocation).toHaveBeenCalledTimes(1);
    expect(legacy.invocation.mock.calls[0][3].contextEnv?.AGENT_BRIDGE_OUTCOME_COMMAND).toBeUndefined();
    expect(legacy.invocation.mock.calls[0][3].contextEnv?.AGENT_BRIDGE_WAIT_COMMAND).toBeUndefined();
    expect(listRunContinuations(legacy.db, "acp:outward")).toHaveLength(0);
    legacy.db.close();
  });

  it("schedules unfinished work after one missing-outcome reconciliation", async () => {
    const { db, engine, handle, invocation } = fixture("continue-after-retry");
    const result = await engine.executePromptAsync("Ship both PRs", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(invocation.mock.calls[1][4].prompt).toContain("Before claiming complete, verify EVERY action");
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

  it("asks the agent to verify every original requested step without a second turn", async () => {
    const { db, engine, handle, invocation } = fixture("report-first");
    await engine.executePromptAsync("Implement, test, review and deploy", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(invocation.mock.calls[0][4].prompt).toContain("Before claiming complete, compare EVERY requested action");
    db.close();
  });

  it("verifies a normal continued Run has a matching durable pending wake", async () => {
    const { db, engine, handle, invocation } = fixture("report-continue");
    await engine.executePromptAsync("Finish later", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(db.getRun("run-one").outcome_status).toBe("continue");
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({
      id: "run-one", originRunId: "run-one", chatKey: "chat", state: "pending",
    })]);
    db.close();
  });

  it.each([
    ["missing", "continue-no-wake"],
    ["cancelled", "continue-cancelled-wake"],
    ["wrong Workstream", "continue-mismatched-wake"],
  ] as const)("does not settle continue with a %s durable wake", async (_reason, mode) => {
    const { db, engine, handle, invocation } = fixture(mode);
    await expect(engine.executePromptAsync("Finish later", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle))
      .rejects.toBeInstanceOf(RunOutcomeReconciliationError);
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(db.getRun("run-one").outcome_status).toBe("continue");
    db.close();
  });

  it("does not settle a Desk continuation for the wrong outward Workstream", async () => {
    const { db, engine, handle, invocation } = fixture("continue-mismatched-binding", "acp:outward");
    await expect(engine.executePromptAsync(
      "Resume this Workstream", null, "chat",
      { publishArtifacts: false, ordinaryWorkstreamId: "ws-trusted" },
      () => {}, [], undefined, "run-one", null, "chat", handle,
    )).rejects.toBeInstanceOf(RunOutcomeReconciliationError);
    expect(invocation).toHaveBeenCalledTimes(1);
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
  it("does not re-prompt a structural ACP refusal solely to obtain an outcome helper call", async () => {
    const { db, engine, handle, invocation } = fixture("refusal");
    const result = await engine.executePromptAsync(
      "Request provider-refused operation", null, "chat", {},
      () => {}, [], undefined, "run-one", null, "chat", handle,
    );
    expect(result.stopReason).toBe("refusal");
    expect(invocation).toHaveBeenCalledTimes(1);
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

  it("does not replace a bound ordinary Desk wake's original native session after a rejected resume", async () => {
    const { db, engine, handle, invocation } = fixture("continue-then-invalid-session", "acp:outward");
    await expect(engine.executePromptAsync(
      "Continue the existing objective", "bound-native-session", "chat",
      { publishArtifacts: false, ordinaryWorkstreamId: "trusted-ws", requireBoundProviderSession: true },
      () => {}, [], undefined, "run-one", null, "chat", handle,
    )).rejects.toThrow("No conversation found with session ID");
    expect(invocation).toHaveBeenCalledTimes(1);
    expect(listRunContinuations(db, "acp:outward")).toEqual([
      expect.objectContaining({ state: "pending", originRunId: "run-one" }),
    ]);
    db.close();
  });

  it("does not substitute a fresh native session via model fallback for a bound Desk wake", async () => {
    const { db, engine, handle, invocation } = fixture("continue-then-model-fallback", "acp:outward");
    await expect(engine.executePromptAsync(
      "Check original task state", "bound-native-session", "chat",
      { publishArtifacts: false, ordinaryWorkstreamId: "trusted-ws", requireBoundProviderSession: true },
      () => {}, [], undefined, "run-one", null, "chat", handle,
    )).rejects.toThrow("usage limit reached");
    expect(invocation).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("discards an abandoned attempt's continue disposition before retrying an invalid provider session", async () => {
    const { db, engine, handle, invocation } = fixture("continue-then-invalid-session");
    await engine.executePromptAsync("Finish release", "stale-session", "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    expect(listRunContinuations(db)).toHaveLength(1);
    expect(listRunContinuations(db)[0]).toEqual(expect.objectContaining({ state: "cancelled", reason: "stale wake" }));
    db.close();
  });

  it("discards an abandoned attempt's continue disposition before retrying another model", async () => {
    const { db, engine, handle, invocation } = fixture("continue-then-model-fallback");
    await engine.executePromptAsync("Finish release", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(invocation).toHaveBeenCalledTimes(2);
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({ state: "cancelled", reason: "stale model wake" })]);
    db.close();
  });

  it("fences an outcome before an ACP-internal retry successor begins", async () => {
    const { db, engine, handle } = fixture("continue-then-internal-retry");
    await engine.executePromptAsync("Finish release", null, "chat", {}, () => {}, [], undefined, "run-one", null, "chat", handle);
    expect(db.getRun("run-one").outcome_status).toBe("complete");
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({ state: "cancelled", reason: "stale internal wake" })]);
    db.close();
  });

});
