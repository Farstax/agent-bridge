import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  AUTONOMOUS_EVENT_SOURCE,
  AUTONOMOUS_RUN_SURFACE,
  AutonomousGoalLaneUnavailableError,
  SqliteAutonomousGoalStore,
  createAutonomousGoal,
  drainAutonomousGoal,
  getAutonomousGoal,
  parseAutonomousCycleResult,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";

function makeDb() {
  const dbPath = join(tmpdir(), `autonomous-goal-runtime-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomous", runId: `process-${Math.random()}` });
  return { db, dbPath };
}

function makeMockClient() {
  return {
    getUpdates: vi.fn().mockResolvedValue({ result: [], ok: true }),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } }),
    sendChatAction: vi.fn().mockResolvedValue({ ok: true }),
    setMyCommands: vi.fn().mockResolvedValue({ ok: true }),
    answerCallbackQuery: vi.fn().mockResolvedValue({ ok: true }),
    editMessageText: vi.fn().mockResolvedValue({ ok: true }),
    sendPhoto: vi.fn().mockResolvedValue({ ok: true }),
    sendDocument: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function claudeOutput(value: unknown, sessionId = "session-1"): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: typeof value === "string" ? value : JSON.stringify(value),
    session_id: sessionId,
  });
}

function makeEngine(runCliAsync: (...args: any[]) => Promise<{ text: string }>, db: ReturnType<typeof openDb>) {
  return new BridgeEngine(
    {
      surfaceIdentity: AUTONOMOUS_RUN_SURFACE,
      kind: "autonomous",
      executionKind: "claude",
      botConfig: { command: "claude", modelPreference: ["default-model"] },
      allowedUserIds: new Set(["42"]),
      executionMode: "safe",
      asyncEnabled: true,
      pollIntervalMs: 1000,
    },
    db,
    makeMockClient(),
    { runCliAsync },
  );
}

function removeDb(dbPath: string) {
  try { rmSync(dbPath); } catch {}
}

describe("autonomous goal production runtime", () => {
  it("persists one goal and drives three real surface-neutral Runs from the original instruction", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "release-readiness",
      prompt: "Improve release readiness",
      constraints: ["stay inside the repository"],
      bot: "claude",
      maxCycles: 3,
    });
    db.close();

    const reopened = openDb(dbPath, { serviceId: "test-autonomous", runId: "process-restarted" });
    const runCliAsync = vi.fn()
      .mockResolvedValueOnce({ text: claudeOutput({ status: "progress", evidence: "cycle one", nextWakeReason: "continue" }) })
      .mockResolvedValueOnce({ text: claudeOutput({ status: "progress", evidence: "cycle two", nextWakeReason: "continue" }) })
      .mockResolvedValueOnce({ text: claudeOutput({ status: "complete", evidence: "release ready" }) });

    await drainAutonomousGoal(reopened, "release-readiness", makeEngine(runCliAsync, reopened));

    expect(runCliAsync).toHaveBeenCalledTimes(3);
    expect(getAutonomousGoal(reopened, "release-readiness")).toMatchObject({
      status: "complete",
      cycle: 3,
      evidence: ["cycle one", "cycle two", "release ready"],
      bot: "claude",
      maxCycles: 3,
    });
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 3 });
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:release-readiness")).toEqual({ count: 3 });
    expect(reopened.raw.prepare("SELECT DISTINCT status FROM bridge_runs WHERE chat_id = ?").all("autonomous:release-readiness")).toEqual([{ status: "done" }]);
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM work_items").get()).toEqual({ count: 0 });
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM work_jobs").get()).toEqual({ count: 0 });

    reopened.close();
    removeDb(dbPath);
  });

  it("deduplicates the same durable wake and creates at most one owning Run", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "dedupe",
      prompt: "Make progress",
      constraints: [],
      bot: "claude",
      maxCycles: 1,
    });
    const store = new SqliteAutonomousGoalStore(db);
    expect(store.scheduleWake("dedupe", { key: "dedupe:wake:0", reason: "duplicate" })).toBe(false);

    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput({ status: "complete", evidence: "done" }) });
    await runNextAutonomousGoal(db, "dedupe", makeEngine(runCliAsync, db));
    await runNextAutonomousGoal(db, "dedupe", makeEngine(runCliAsync, db));

    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:dedupe")).toEqual({ count: 1 });

    db.close();
    removeDb(dbPath);
  });

  it("survives restart after successor persistence without duplicating the first Run", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "restart",
      prompt: "Finish in two cycles",
      constraints: [],
      bot: "claude",
      maxCycles: 2,
    });
    const firstCli = vi.fn().mockResolvedValue({ text: claudeOutput({ status: "progress", evidence: "first", nextWakeReason: "finish" }) });
    await runNextAutonomousGoal(db, "restart", makeEngine(firstCli, db));
    expect(getAutonomousGoal(db, "restart").cycle).toBe(1);
    db.close();

    const reopened = openDb(dbPath, { serviceId: "test-autonomous", runId: "process-after-successor" });
    const secondCli = vi.fn().mockResolvedValue({ text: claudeOutput({ status: "complete", evidence: "second" }) });
    await drainAutonomousGoal(reopened, "restart", makeEngine(secondCli, reopened));

    expect(firstCli).toHaveBeenCalledTimes(1);
    expect(secondCli).toHaveBeenCalledTimes(1);
    expect(getAutonomousGoal(reopened, "restart")).toMatchObject({ status: "complete", cycle: 2, evidence: ["first", "second"] });
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:restart")).toEqual({ count: 2 });

    reopened.close();
    removeDb(dbPath);
  });

  it("fences concurrent execution of the same goal on one dedicated lane", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "fenced",
      prompt: "Do one thing",
      constraints: [],
      bot: "claude",
      maxCycles: 1,
    });
    const held = db.acquireLock(AUTONOMOUS_RUN_SURFACE, "autonomous:fenced");
    expect(held).not.toBeNull();
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput({ status: "complete", evidence: "done" }) });

    await expect(runNextAutonomousGoal(db, "fenced", makeEngine(runCliAsync, db))).rejects.toBeInstanceOf(AutonomousGoalLaneUnavailableError);
    expect(runCliAsync).not.toHaveBeenCalled();

    db.unlock(held!);
    await runNextAutonomousGoal(db, "fenced", makeEngine(runCliAsync, db));
    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:fenced")).toEqual({ count: 1 });

    db.close();
    removeDb(dbPath);
  });

  it("fails malformed provider cycle output closed with no successor wake", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "malformed",
      prompt: "Do one thing",
      constraints: [],
      bot: "claude",
      maxCycles: 3,
    });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("not-json") });

    await runNextAutonomousGoal(db, "malformed", makeEngine(runCliAsync, db));

    expect(getAutonomousGoal(db, "malformed")).toMatchObject({ status: "blocked", cycle: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT status FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ status: "failed" });
    expect(db.raw.prepare("SELECT status FROM bridge_runs WHERE chat_id = ?").get("autonomous:malformed")).toEqual({ status: "failed" });

    db.close();
    removeDb(dbPath);
  });

  it("stops mechanically at the persisted cycle budget", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "budget",
      prompt: "Keep working",
      constraints: [],
      bot: "claude",
      maxCycles: 2,
    });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput({ status: "progress", evidence: "still working", nextWakeReason: "continue" }) });

    await drainAutonomousGoal(db, "budget", makeEngine(runCliAsync, db));

    expect(runCliAsync).toHaveBeenCalledTimes(2);
    expect(getAutonomousGoal(db, "budget")).toMatchObject({ status: "budget_exhausted", cycle: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 2 });

    db.close();
    removeDb(dbPath);
  });
});

describe("parseAutonomousCycleResult", () => {
  it("accepts the narrow structured result and rejects prose or unknown fields", () => {
    expect(parseAutonomousCycleResult(JSON.stringify({ status: "progress", evidence: "made progress", nextWakeReason: "continue" }))).toEqual({
      status: "progress",
      evidence: "made progress",
      nextWakeReason: "continue",
    });
    expect(() => parseAutonomousCycleResult("```json\n{\"status\":\"complete\",\"evidence\":\"done\"}\n```")).toThrow();
    expect(() => parseAutonomousCycleResult(JSON.stringify({ status: "complete", evidence: "done", command: "deploy" }))).toThrow();
  });
});
