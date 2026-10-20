import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { missingOutcomeRetries, readRunOutcome, requestAgentBridgeOutcome, requestAgentBridgeWait } from "../src/runOutcome.js";
import { listRunContinuations } from "../src/runContinuation.js";

const dirs: string[] = [];
const scope = { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "run-outcome-test-")); dirs.push(dir);
  const path = join(dir, "bridge.sqlite");
  const db = openDb(path, { serviceId: "outcome-test", runId: "process" });
  db.insertRun("run-1", scope, "codex");
  const lock = db.acquireLock(scope.surfaceIdentity, scope.chatKey);
  if (!lock) throw new Error("missing fixture lane lock");
  const env = {
    AGENT_BRIDGE_LOCK_SERVICE_ID: lock.serviceId,
    AGENT_BRIDGE_LOCK_RUN_ID: lock.runId,
    AGENT_BRIDGE_LOCK_ACQUISITION_ID: lock.acquisitionId,
    AGENT_BRIDGE_CONTEXT_DB: path,
    AGENT_BRIDGE_RUN_ID: "run-1",
    AGENT_BRIDGE_SURFACE_IDENTITY: scope.surfaceIdentity,
    AGENT_BRIDGE_CHAT_KEY: scope.chatKey,
    AGENT_BRIDGE_PROVIDER: "codex",
    AGENT_BRIDGE_DELIVERY_CHAT_ID: "chat-1",
    AGENT_BRIDGE_DELIVERY_CHAT_TYPE: "private",
  };
  return { db, env, path };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Run-scoped provider outcomes", () => {
  it("defaults to one missing-outcome retry, optionally disabled", () => {
    expect(missingOutcomeRetries({})).toBe(1);
    expect(missingOutcomeRetries({ AGENT_BRIDGE_MISSING_OUTCOME_RETRIES: "0" })).toBe(0);
    expect(() => missingOutcomeRetries({ AGENT_BRIDGE_MISSING_OUTCOME_RETRIES: "2" })).toThrow();
  });

  it("records completion durably in the owning Run rather than interpreting final text", () => {
    const { db, env, path } = setup();
    expect(readRunOutcome(db, "run-1")).toBeNull();
    expect(requestAgentBridgeOutcome(["complete", "--evidence", "verified tests"], env)).toMatch(/complete/);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "complete", detail: "verified tests" });
    db.close();
    const reopened = openDb(path, { serviceId: "outcome-test-restart", runId: "process-restart" });
    expect(readRunOutcome(reopened, "run-1")).toEqual({ status: "complete", detail: "verified tests" });
    reopened.close();
  });

  it("persists an unfinished disposition and schedules an existing bounded wake atomically", () => {
    const { db, env } = setup();
    expect(requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "CI pending; re-check"], env))
      .toMatch(/Continuation scheduled/);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "continue", detail: "CI pending; re-check" });
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({
      originRunId: "run-1", provider: "codex", reason: "CI pending; re-check", state: "pending",
    })]);
    db.close();
  });

  it("keeps the legacy wait helper usable without lane credentials", () => {
    const { db, env } = setup();
    const {
      AGENT_BRIDGE_LOCK_SERVICE_ID: _service,
      AGENT_BRIDGE_LOCK_RUN_ID: _lockRun,
      AGENT_BRIDGE_LOCK_ACQUISITION_ID: _acquisition,
      ...legacyEnv
    } = env;
    expect(requestAgentBridgeWait(["--after-seconds", "60", "--reason", "legacy wake"], legacyEnv))
      .toMatch(/Continuation scheduled/);
    expect(listRunContinuations(db)).toEqual([expect.objectContaining({ reason: "legacy wake" })]);
    // The legacy helper did not require the newer explicit disposition.
    expect(readRunOutcome(db, "run-1")).toBeNull();
    db.close();
  });

  it("uses the same outcome path for a wait call made by a new ordinary Run", () => {
    const { db, env } = setup();
    requestAgentBridgeWait(["--after-seconds", "60", "--reason", "CI pending"], env);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "continue", detail: "CI pending" });
    expect(listRunContinuations(db)).toHaveLength(1);
    db.close();
  });

  it("reports an explicit blocker without scheduling another Run", () => {
    const { db, env } = setup();
    requestAgentBridgeOutcome(["blocked", "--reason", "Owner approval is required"], env);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "blocked", detail: "Owner approval is required" });
    expect(listRunContinuations(db)).toHaveLength(0);
    db.close();
  });

  it("rejects conflicting outcomes and foreign Run identities without altering the first", () => {
    const { db, env } = setup();
    requestAgentBridgeOutcome(["complete", "--evidence", "verified"], env);
    expect(() => requestAgentBridgeOutcome(["blocked", "--reason", "approval"], env)).toThrow(/already recorded/);
    expect(() => requestAgentBridgeOutcome(["complete", "--evidence", "verified"], {
      ...env, AGENT_BRIDGE_CHAT_KEY: "other-chat",
    })).toThrow(/identity/);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "complete", detail: "verified" });
    db.close();
  });

  it("refuses terminal or cancelled Runs and never schedules a wake for them", () => {
    const { db, env } = setup();
    expect(db.updateRunCancelled("run-1", "operator")).toBe(true);
    expect(() => requestAgentBridgeOutcome(["continue", "--after-seconds", "60", "--reason", "retry"], env))
      .toThrow(/not active/);
    expect(listRunContinuations(db)).toHaveLength(0);
    db.close();
  });

  it("rejects a stale execution acquisition even if the Run row remains running", () => {
    const { db, env } = setup();
    expect(() => requestAgentBridgeOutcome(["complete", "--evidence", "verified"], {
      ...env, AGENT_BRIDGE_LOCK_ACQUISITION_ID: "stale",
    })).toThrow(/ownership/);
    expect(readRunOutcome(db, "run-1")).toBeNull();
    db.close();
  });

  it("preserves the unscoped legacy wait command outside an outcome-enabled lane", () => {
    const { db, env } = setup();
    const legacyEnv = { ...process.env, ...env };
    delete legacyEnv.AGENT_BRIDGE_LOCK_SERVICE_ID;
    delete legacyEnv.AGENT_BRIDGE_LOCK_RUN_ID;
    delete legacyEnv.AGENT_BRIDGE_LOCK_ACQUISITION_ID;
    const output = execFileSync(join(process.cwd(), "bin", "agent-bridge-wait"), [
      "--after-seconds", "60", "--reason", "previously supported legacy caller",
    ], { env: legacyEnv, encoding: "utf8" });
    expect(output).toMatch(/Continuation scheduled/);
    expect(readRunOutcome(db, "run-1")).toBeNull();
    expect(listRunContinuations(db)).toHaveLength(1);
    db.close();
  });

  it("makes a legacy wait call count as continue on an outcome-enabled Run", () => {
    const { db, env } = setup();
    const output = execFileSync(join(process.cwd(), "bin", "agent-bridge-wait"), [
      "--after-seconds", "60", "--reason", "CI pending",
    ], { env: { ...process.env, ...env }, encoding: "utf8" });
    expect(output).toMatch(/Continuation scheduled/);
    expect(readRunOutcome(db, "run-1")).toEqual({ status: "continue", detail: "CI pending" });
    db.close();
  });

  it("fails atomically if continuation delay is invalid", () => {
    const { db, env } = setup();
    expect(() => requestAgentBridgeOutcome(["continue", "--after-seconds", "0", "--reason", "retry"], env)).toThrow();
    expect(readRunOutcome(db, "run-1")).toBeNull();
    db.close();
  });
});
