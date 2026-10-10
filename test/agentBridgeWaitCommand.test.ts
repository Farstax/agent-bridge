import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listRunContinuations, scanRunContinuations } from "../src/runContinuation.js";
import { persistProviderSession } from "../src/providers/sessionRuntime.js";

const paths: string[] = [];
const command = join(process.cwd(), "bin", "agent-bridge-wait");
const baseEnv = (dbPath: string, originRunId = "wait-origin") => ({
  ...process.env,
  AGENT_BRIDGE_CONTEXT_DB: dbPath,
  AGENT_BRIDGE_RUN_ID: originRunId,
  AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
  AGENT_BRIDGE_CHAT_KEY: "123",
  AGENT_BRIDGE_PROVIDER: "codex",
  AGENT_BRIDGE_DELIVERY_CHAT_ID: "123",
  AGENT_BRIDGE_DELIVERY_CHAT_TYPE: "private",
});

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, { cwd: process.cwd(), env, encoding: "utf8" });
}

function setup(originRunId = "wait-origin") {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-wait-command-"));
  const dbPath = join(dir, "bridge.sqlite");
  paths.push(dir);
  const db = openDb(dbPath, { serviceId: "wait-command-test", runId: "test-process" });
  db.insertRun(originRunId, { surfaceIdentity: "telegram:interactive", chatKey: "123" }, "codex");
  return { db, dbPath, originRunId };
}

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("agent-bridge-wait executable", () => {
  it("registers through the installed wrapper and wakes exactly once", async () => {
    const { db, dbPath, originRunId } = setup();
    db.close();

    const result = run(["--after-seconds", "5", "--reason", "CI is pending"], baseEnv(dbPath, originRunId));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Continuation scheduled");

    const reopened = openDb(dbPath, { serviceId: "wait-command-reopen", runId: "test-process-2" });
    expect(listRunContinuations(reopened)).toEqual([expect.objectContaining({ id: originRunId, state: "pending" })]);
    persistProviderSession(reopened, { surfaceIdentity: "telegram:interactive", chatKey: "123" }, "codex", "resumable-session", originRunId);
    expect(reopened.updateRunCompleted(originRunId, "done", "resumable-session")).toBe(true);
    let dispatchCount = 0;
    const dispatch = async () => { dispatchCount += 1; };
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, Date.now() + 6_000);
    await scanRunContinuations(reopened, "telegram:interactive", dispatch, Date.now() + 7_000);
    expect(dispatchCount).toBe(1);
    expect(listRunContinuations(reopened)).toEqual([expect.objectContaining({ state: "completed" })]);
    reopened.close();
  });

  it("rejects absent scoped context, invalid delay, and terminal origins", () => {
    const { db, dbPath, originRunId } = setup();
    const missingEnv = { ...process.env };
    for (const key of [
      "AGENT_BRIDGE_CONTEXT_DB",
      "AGENT_BRIDGE_RUN_ID",
      "AGENT_BRIDGE_SURFACE_IDENTITY",
      "AGENT_BRIDGE_CHAT_KEY",
      "AGENT_BRIDGE_PROVIDER",
      "AGENT_BRIDGE_DELIVERY_CHAT_ID",
      "AGENT_BRIDGE_DELIVERY_CHAT_TYPE",
    ]) delete missingEnv[key];
    const missing = run(["--after-seconds", "5", "--reason", "wait"], missingEnv);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("AGENT_BRIDGE_CONTEXT_DB is required");

    const invalidDelay = run(["--after-seconds", "4", "--reason", "wait"], baseEnv(dbPath, originRunId));
    expect(invalidDelay.status).toBe(1);
    expect(invalidDelay.stderr).toContain("between 5 and 1800");

    expect(db.updateRunCompleted(originRunId, "done", "session")).toBe(true);
    db.close();
    const terminal = run(["--after-seconds", "5", "--reason", "wait"], baseEnv(dbPath, originRunId));
    expect(terminal.status).toBe(1);
    expect(terminal.stderr).toContain("originating Run is no longer active");
  });
});
