import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  runNextAutonomousGoal,
  runAutonomousGoalOperator,
  runAutonomousGoalOperatorStandalone,
  standaloneBotConfig,
  standaloneSoulContext,
  buildStandaloneEngine,
  cancelAutonomousGoal,
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


type TestDisposition = "continue" | "done" | "blocked";

type DispositionCliResult = {
  text: string;
  autonomyDisposition: TestDisposition;
  autonomyNotify?: boolean;
};

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function invokeDisposition(prompt: string, disposition: TestDisposition, notify = false): void {
  execFileSync(dispositionCommand(prompt), [disposition, ...(notify ? ["--notify"] : [])], { stdio: "pipe" });
}

function cycleOutput(disposition: TestDisposition, evidence: string, notify = false): DispositionCliResult {
  return {
    text: claudeOutput(evidence),
    autonomyDisposition: disposition,
    ...(notify ? { autonomyNotify: true } : {}),
  };
}

function adaptSurfaceResult(input: any, result: any): any {
  if (!result?.autonomyDisposition) return result;
  invokeDisposition(input.prompt, result.autonomyDisposition, result.autonomyNotify === true);
  const envelope = JSON.parse(result.text) as { result?: unknown };
  if (typeof envelope.result !== "string") throw new Error("invalid test provider result envelope");
  return { text: envelope.result } as any;
}

function mockSurfaceNeutral(engine: BridgeEngine, implementation: (input: any) => Promise<any>) {
  return vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(async (input: any) =>
    adaptSurfaceResult(input, await implementation(input)));
}

function makeEngine(runCliAsync: (...args: any[]) => Promise<{ text: string }>, db: ReturnType<typeof openDb>) {
  const dispositionAwareRunCliAsync = async (...args: any[]) => {
    const result = await runCliAsync(...args) as { text: string; autonomyDisposition?: TestDisposition; autonomyNotify?: boolean };
    if (!result.autonomyDisposition) return result;
    const cliArgs = Array.isArray(args[1]) ? args[1] : [];
    const prompt = cliArgs.find((arg: unknown) => typeof arg === "string" && arg.includes("Autonomy disposition command: "));
    if (typeof prompt !== "string") throw new Error("autonomous prompt not found in test CLI invocation");
    invokeDisposition(prompt, result.autonomyDisposition, result.autonomyNotify === true);
    return { text: result.text };
  };
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
    { runCliAsync: dispositionAwareRunCliAsync as any },
  );
}

function removeDb(dbPath: string) {
  try { rmSync(dbPath); } catch {}
}

describe("autonomous goal production runtime", () => {
  it("inherits the complete bounded goal context into every execution seam input", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "context",
      prompt: "Original goal",
      constraints: ["no deploy", "read-only evidence"],
      bot: "claude",
      maxCycles: 2,
    });
    const inputs: any[] = [];
    const engine = makeEngine(vi.fn(), db);
    mockSurfaceNeutral(engine, async (input: any) => {
      inputs.push(input);
      return cycleOutput(inputs.length === 1 ? "continue" : "done", `cycle-${inputs.length}`) as any;
    });

    await drainAutonomousGoal(db, "context", engine);

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.prompt)).toEqual([
      expect.stringContaining("Original goal"),
      expect.stringContaining("Original goal"),
    ]);
    for (const [index, input] of inputs.entries()) {
      expect(input.prompt).toContain("no deploy");
      expect(input.prompt).toContain("read-only evidence");
      expect(input.prompt).toContain(`Current cycle: ${index + 1}`);
      expect(input.prompt).toContain(index === 0 ? "Prior evidence: none" : "cycle-1");
      expect(input.prompt).toContain(index === 0 ? "Wake reason: initial" : "Wake reason: provider requested continuation");
      expect(input.prompt).toContain("Autonomy disposition command: ");
      expect(input.prompt).toContain("continue, done, or blocked");
      expect(input.prompt).not.toContain("Return JSON only");
      expect(input.prompt).toContain("authority");
    }

    db.close();
    removeDb(dbPath);
  });

  it.each([
    ["done", "complete"],
    ["blocked", "blocked"],
  ] as const)("treats a valid %s disposition as terminal", async (providerDisposition, expectedStatus) => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: `terminal-${providerDisposition}`, prompt: "Stop", constraints: [], bot: "claude", maxCycles: 3 });
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput(providerDisposition, providerDisposition));

    await runNextAutonomousGoal(db, `terminal-${providerDisposition}`, makeEngine(runCliAsync, db));

    expect(getAutonomousGoal(db, `terminal-${providerDisposition}`)).toMatchObject({ status: expectedStatus, cycle: 1, evidence: [providerDisposition] });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ? AND status = 'received'").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 0 });

    db.close();
    removeDb(dbPath);
  });

  it("invokes an optional onCycleReconciled observer after each cycle reconciles, exposing only existing bounded fields (#326)", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "observed", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 3 });
    const runCliAsync = vi.fn()
      .mockResolvedValueOnce(cycleOutput("continue", "cycle one"))
      .mockResolvedValueOnce(cycleOutput("done", "cycle two done"));
    const events: any[] = [];

    await drainAutonomousGoal(db, "observed", makeEngine(runCliAsync, db), (event) => events.push(event));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 1, goalStatus: "active", disposition: "continue", evidence: "cycle one", notify: false });
    expect(events[1]).toMatchObject({ type: "autonomous_cycle_reconciled", goalId: "observed", cycle: 2, goalStatus: "complete", disposition: "done", evidence: "cycle two done", notify: false });
    expect(typeof events[0].runId).toBe("string");
    // No raw provider stdout, transcript, hidden reasoning, or tool logs.
    expect(Object.keys(events[0]).sort()).toEqual(["cycle", "disposition", "evidence", "goalId", "goalStatus", "notify", "runId", "type"]);

    db.close();
    removeDb(dbPath);
  });

  it("observer absence does not change cycle ownership or outcome", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "unobserved", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 1 });
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done"));

    await drainAutonomousGoal(db, "unobserved", makeEngine(runCliAsync, db));

    expect(getAutonomousGoal(db, "unobserved")).toMatchObject({ status: "complete" });
    db.close();
    removeDb(dbPath);
  });

  it("an observer that throws does not break cycle reconciliation or goal state", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "observer-throws", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 1 });
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done"));

    await drainAutonomousGoal(db, "observer-throws", makeEngine(runCliAsync, db), () => { throw new Error("observer boom"); });

    expect(getAutonomousGoal(db, "observer-throws")).toMatchObject({ status: "complete" });
    db.close();
    removeDb(dbPath);
  });

  it("does not persist a successor after authoritative cancellation wins a provider race", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "cancel-race", prompt: "Do not revive", constraints: [], bot: "claude", maxCycles: 3 });
    let started!: (value: unknown) => void;
    const providerFinished = new Promise<unknown>((resolve) => { started = resolve; });
    const engine = makeEngine(vi.fn(), db);
    mockSurfaceNeutral(engine, async (input: any) => {
      await providerFinished;
      return cycleOutput("continue", "late progress") as any;
    });

    const attempt = runNextAutonomousGoal(db, "cancel-race", engine);
    while (db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:cancel-race").count !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const run = db.raw.prepare("SELECT run_id FROM bridge_runs WHERE chat_id = ?").get("autonomous:cancel-race") as { run_id: string };
    expect(db.updateRunCancelled(run.run_id, "operator fence")).toBe(true);
    started(undefined);
    await attempt;

    expect(getAutonomousGoal(db, "cancel-race")).toMatchObject({ status: "cancelled", cycle: 1 });
    expect(getAutonomousGoal(db, "cancel-race").evidence.at(-1)).toContain("operator fence");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ? AND status = 'received'").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 0 });

    db.close();
    removeDb(dbPath);
  });

  it("cancels an idle active goal directly (no in-flight run) and cancels its pending wake, through existing cancellation ownership (#326)", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "idle-cancel", prompt: "Stop me", constraints: [], bot: "claude", maxCycles: 3 });

    const cancelled = await cancelAutonomousGoal(db, "idle-cancel", "owner stop");

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.evidence.at(-1)).toContain("owner stop");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ? AND status = 'received'").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 0 });

    db.close();
    removeDb(dbPath);
  });

  it("is idempotent — cancelling an already-terminal goal is a safe no-op", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "already-done", prompt: "Finish", constraints: [], bot: "claude", maxCycles: 1 });
    await runNextAutonomousGoal(db, "already-done", makeEngine(vi.fn().mockResolvedValue(cycleOutput("done", "finished")), db));
    expect(getAutonomousGoal(db, "already-done").status).toBe("complete");

    const result = await cancelAutonomousGoal(db, "already-done", "owner stop");

    expect(result.status).toBe("complete");
    expect(result.evidence).toEqual(["finished"]);

    db.close();
    removeDb(dbPath);
  });

  it("fences an in-flight run through existing cancellation ownership so late provider completion never becomes authoritative", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "inflight-cancel", prompt: "Keep going", constraints: [], bot: "claude", maxCycles: 3 });
    let started!: (value: unknown) => void;
    const providerFinished = new Promise<unknown>((resolve) => { started = resolve; });
    const engine = makeEngine(vi.fn(), db);
    mockSurfaceNeutral(engine, async () => {
      await providerFinished;
      return cycleOutput("continue", "late progress") as any;
    });

    const attempt = runNextAutonomousGoal(db, "inflight-cancel", engine);
    while (db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:inflight-cancel").count !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const cancelled = await cancelAutonomousGoal(db, "inflight-cancel", "emergency stop", { killRunOwnedDescendants: async () => {} });
    // Cancellation of an in-flight run defers finalization to the existing
    // reconcile() cancellation-race path — Platform must not overwrite goal
    // state directly while a provider call is still outstanding.
    expect(cancelled.status).toBe("active");

    started(undefined);
    await attempt;

    expect(getAutonomousGoal(db, "inflight-cancel").status).toBe("cancelled");
    expect(getAutonomousGoal(db, "inflight-cancel").evidence.at(-1)).toContain("emergency stop");

    db.close();
    removeDb(dbPath);
  });

  it("kills the run's actual OS-owned processes via the cross-process AGENT_BRIDGE_RUN_ID primitive, not the process-local abort map (#439 review)", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "cross-process-cancel", prompt: "Keep going", constraints: [], bot: "claude", maxCycles: 3 });
    let started!: (value: unknown) => void;
    const providerFinished = new Promise<unknown>((resolve) => { started = resolve; });
    const engine = makeEngine(vi.fn(), db);
    mockSurfaceNeutral(engine, async () => {
      await providerFinished;
      return cycleOutput("continue", "late") as any;
    });
    const attempt = runNextAutonomousGoal(db, "cross-process-cancel", engine);
    while (db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:cross-process-cancel").count !== 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const run = db.raw.prepare("SELECT run_id FROM bridge_runs WHERE chat_id = ?").get("autonomous:cross-process-cancel") as { run_id: string };
    const killCalls: string[] = [];

    await cancelAutonomousGoal(db, "cross-process-cancel", "emergency stop", {
      killRunOwnedDescendants: async (runId) => { killCalls.push(runId); },
    });

    expect(killCalls).toEqual([run.run_id]);

    started(undefined);
    await attempt;
    db.close();
    removeDb(dbPath);
  });

  it("exposes cancel through the operator seam", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "operator-cancel", prompt: "Stop via operator", constraints: [], bot: "claude", maxCycles: 3 });

    const result = await runAutonomousGoalOperator(db, ["cancel", "operator-cancel", "owner", "requested", "stop"]);

    expect(result.status).toBe("cancelled");
    expect(result.evidence.at(-1)).toContain("owner requested stop");

    db.close();
    removeDb(dbPath);
  });

  it("forwards onCycleReconciled through runAutonomousGoalOperator's run operation (#326)", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "operator-observed", prompt: "Do work", constraints: [], bot: "claude", maxCycles: 1 });
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done via operator"));
    const events: any[] = [];

    await runAutonomousGoalOperator(db, ["run", "operator-observed"], makeEngine(runCliAsync, db), (event) => events.push(event));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ goalId: "operator-observed", evidence: "done via operator" });

    db.close();
    removeDb(dbPath);
  });

  it("forwards onCycleReconciled through the standalone operator seam (#326)", async () => {
    const dbPath = join(tmpdir(), `autonomous-goal-standalone-observed-${Date.now()}-${Math.random()}.sqlite`);
    openDb(dbPath, { serviceId: "test-standalone-observed-seed", runId: `seed-${Math.random()}` }).close();
    const events: any[] = [];
    const engineFactory = (db: any) => {
      const engine = makeEngine(vi.fn(), db);
      mockSurfaceNeutral(engine, async () => cycleOutput("done", "standalone observed") as any);
      return engine;
    };

    await runAutonomousGoalOperatorStandalone(dbPath, ["create", "standalone-observed", "Do work", "--max-cycles", "1"], { engineFactory });
    await runAutonomousGoalOperatorStandalone(dbPath, ["run", "standalone-observed"], { engineFactory, onCycleReconciled: (event) => events.push(event) });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ goalId: "standalone-observed", evidence: "standalone observed" });

    removeDb(dbPath);
  });

  it("lets two real concurrent attempts race and only one owns a Run and reaches the provider", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "concurrent", prompt: "One run", constraints: [], bot: "claude", maxCycles: 1 });
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done"));

    const results = await Promise.allSettled([
      runNextAutonomousGoal(db, "concurrent", makeEngine(runCliAsync, db)),
      runNextAutonomousGoal(db, "concurrent", makeEngine(runCliAsync, db)),
    ]);

    expect(results).toHaveLength(2);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:concurrent")).toEqual({ count: 1 });

    db.close();
    removeDb(dbPath);
  });

  it("mechanically invokes only BridgeEngine.executeSurfaceNeutralTurn", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "seam", prompt: "Use the seam", constraints: [], bot: "claude", maxCycles: 1 });
    const directCli = vi.fn().mockRejectedValue(new Error("direct provider invocation is forbidden"));
    const engine = makeEngine(directCli, db);
    const surfaceNeutral = mockSurfaceNeutral(engine, async () => cycleOutput("done", "seam reached") as any);

    await runNextAutonomousGoal(db, "seam", engine);

    expect(surfaceNeutral).toHaveBeenCalledTimes(1);
    expect(directCli).not.toHaveBeenCalled();

    db.close();
    removeDb(dbPath);
  });

  it("provides a controlled create, drain, and status operator surface", async () => {
    const { db, dbPath } = makeDb();
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "operator done"));
    const engine = makeEngine(runCliAsync, db);

    expect(await runAutonomousGoalOperator(db, ["create", "operator-goal", "Operator goal", "--max-cycles", "1"])).toMatchObject({ goalId: "operator-goal", status: "active" });
    expect(await runAutonomousGoalOperator(db, ["run", "operator-goal"], engine)).toMatchObject({ goalId: "operator-goal", status: "complete" });
    expect(await runAutonomousGoalOperator(db, ["status", "operator-goal"])).toMatchObject({ goalId: "operator-goal", status: "complete" });

    db.close();
    removeDb(dbPath);
  });

  it("defaults to operator-approved constraints and the claude bot when --constraints/--bot are not given (backward compatible)", async () => {
    const { db, dbPath } = makeDb();
    const goal = await runAutonomousGoalOperator(db, ["create", "default-goal", "Default goal", "--max-cycles", "1"]);
    expect(goal).toMatchObject({ goalId: "default-goal", bot: "claude", constraints: ["operator-approved goal authority"] });
    db.close();
    removeDb(dbPath);
  });

  it("accepts explicit --constraints (pipe-delimited) and --bot so a caller can create a goal under its own durable constraints and provider", async () => {
    const { db, dbPath } = makeDb();
    const goal = await runAutonomousGoalOperator(db, [
      "create", "company-goal", "Determine the highest-value obstacle and make progress",
      "--constraints", "preserve production reliability|no new external trust without owner authorisation",
      "--bot", "codex",
      "--max-cycles", "2",
    ]);
    expect(goal).toMatchObject({
      goalId: "company-goal",
      prompt: "Determine the highest-value obstacle and make progress",
      bot: "codex",
      maxCycles: 2,
      constraints: ["preserve production reliability", "no new external trust without owner authorisation"],
    });
    db.close();
    removeDb(dbPath);
  });

  it("carries the operator-created prompt and durable constraints through to the existing executeSurfaceNeutralTurn owner", async () => {
    const { db, dbPath } = makeDb();
    await runAutonomousGoalOperator(db, [
      "create", "company-goal-run", "Grow the beta activation outcome",
      "--constraints", "preserve production reliability|no new external trust without owner authorisation",
      "--bot", "codex",
      "--max-cycles", "1",
    ]);
    const inputs: any[] = [];
    const engine = makeEngine(vi.fn(), db);
    mockSurfaceNeutral(engine, async (input: any) => {
      inputs.push(input);
      return cycleOutput("done", "done") as any;
    });

    const result = await runAutonomousGoalOperator(db, ["run", "company-goal-run"], engine);

    expect(result).toMatchObject({ goalId: "company-goal-run", status: "complete", bot: "codex" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toContain("Grow the beta activation outcome");
    expect(inputs[0].prompt).toContain("preserve production reliability");
    expect(inputs[0].prompt).toContain("no new external trust without owner authorisation");
    db.close();
    removeDb(dbPath);
  });

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
      .mockResolvedValueOnce(cycleOutput("continue", "cycle one"))
      .mockResolvedValueOnce(cycleOutput("continue", "cycle two"))
      .mockResolvedValueOnce(cycleOutput("done", "release ready"));

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

    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done"));
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
    const firstCli = vi.fn().mockResolvedValue(cycleOutput("continue", "first"));
    await runNextAutonomousGoal(db, "restart", makeEngine(firstCli, db));
    expect(getAutonomousGoal(db, "restart").cycle).toBe(1);
    db.close();

    const reopened = openDb(dbPath, { serviceId: "test-autonomous", runId: "process-after-successor" });
    const secondCli = vi.fn().mockResolvedValue(cycleOutput("done", "second"));
    await drainAutonomousGoal(reopened, "restart", makeEngine(secondCli, reopened));

    expect(firstCli).toHaveBeenCalledTimes(1);
    expect(secondCli).toHaveBeenCalledTimes(1);
    expect(getAutonomousGoal(reopened, "restart")).toMatchObject({ status: "complete", cycle: 2, evidence: ["first", "second"] });
    expect(reopened.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:restart")).toEqual({ count: 2 });

    reopened.close();
    removeDb(dbPath);
  });

  it("fails closed after restart when a wake was claimed and its owning Run was left unreconciled", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "claimed-crash",
      prompt: "Do not replay an unknown provider attempt",
      constraints: [],
      bot: "claude",
      maxCycles: 3,
    });
    const wake = db.raw.prepare("SELECT id FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE) as { id: number };
    const runId = "crashed-autonomous-run";
    db.insertRun(runId, "autonomous:claimed-crash", "claude");
    db.linkEventReceiptRun(wake.id, runId);
    db.close();

    const reopened = openDb(dbPath, { serviceId: "test-autonomous", runId: "process-after-claim-crash" });
    const provider = vi.fn();
    await drainAutonomousGoal(reopened, "claimed-crash", makeEngine(provider, reopened));

    expect(provider).not.toHaveBeenCalled();
    expect(getAutonomousGoal(reopened, "claimed-crash")).toMatchObject({ status: "blocked", cycle: 1 });
    expect(reopened.raw.prepare("SELECT status FROM event_receipts WHERE id = ?").get(wake.id)).toEqual({ status: "failed" });
    expect(reopened.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = ?").get(runId)).toEqual({ status: "failed" });

    reopened.close();
    removeDb(dbPath);
  });

  it("detects an active goal with no pending or recoverable wake instead of spinning", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, { goalId: "missing-wake", prompt: "Missing wake", constraints: [], bot: "claude", maxCycles: 2 });
    db.raw.prepare("DELETE FROM event_receipts WHERE source = ?").run(AUTONOMOUS_EVENT_SOURCE);

    await expect(drainAutonomousGoal(db, "missing-wake", makeEngine(vi.fn(), db))).rejects.toThrow(/no pending or recoverable autonomous wake/i);

    db.close();
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
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("done", "done"));

    await expect(runNextAutonomousGoal(db, "fenced", makeEngine(runCliAsync, db))).rejects.toBeInstanceOf(AutonomousGoalLaneUnavailableError);
    expect(runCliAsync).not.toHaveBeenCalled();

    db.unlock(held!);
    await runNextAutonomousGoal(db, "fenced", makeEngine(runCliAsync, db));
    expect(runCliAsync).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE chat_id = ?").get("autonomous:fenced")).toEqual({ count: 1 });

    db.close();
    removeDb(dbPath);
  });

  it("fails a successful provider response with no disposition closed with no successor wake", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoal(db, {
      goalId: "malformed",
      prompt: "Do one thing",
      constraints: [],
      bot: "claude",
      maxCycles: 3,
    });
    const runCliAsync = vi.fn().mockResolvedValue({ text: claudeOutput("ordinary response without a disposition") });

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
    const runCliAsync = vi.fn().mockResolvedValue(cycleOutput("continue", "still working"));

    await drainAutonomousGoal(db, "budget", makeEngine(runCliAsync, db));

    expect(runCliAsync).toHaveBeenCalledTimes(2);
    expect(getAutonomousGoal(db, "budget")).toMatchObject({ status: "budget_exhausted", cycle: 2 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ?").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 2 });

    db.close();
    removeDb(dbPath);
  });
});

describe("runAutonomousGoalOperatorStandalone", () => {
  it("is a genuinely runnable single-call seam: opens its own db, creates under custom constraints/bot, and drains via a real (injectable) engine", async () => {
    const dbPath = join(tmpdir(), `autonomous-goal-standalone-${Date.now()}-${Math.random()}.sqlite`);
    // runAutonomousGoalOperatorStandalone uses openProductionDb, which fails
    // closed on a missing file rather than silently creating one — the
    // database must already exist (as it would on a real running bridge).
    openDb(dbPath, { serviceId: "test-autonomous-standalone-seed", runId: `seed-${Math.random()}` }).close();
    const inputs: any[] = [];
    const factoryBotArgs: string[] = [];
    const engineFactory = (db: any, bot: string) => {
      factoryBotArgs.push(bot);
      const engine = makeEngine(vi.fn(), db);
      mockSurfaceNeutral(engine, async (input: any) => {
        inputs.push(input);
        return cycleOutput("done", "done") as any;
      });
      return engine;
    };

    const created = await runAutonomousGoalOperatorStandalone(dbPath, [
      "create", "standalone-goal", "Do the standalone thing",
      "--constraints", "preserve production reliability",
      "--bot", "codex",
      "--max-cycles", "1",
    ], { engineFactory });
    expect(created).toMatchObject({ goalId: "standalone-goal", bot: "codex", status: "active" });

    const drained = await runAutonomousGoalOperatorStandalone(dbPath, ["run", "standalone-goal"], { engineFactory });
    expect(drained).toMatchObject({ goalId: "standalone-goal", status: "complete" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0].prompt).toContain("Do the standalone thing");
    expect(inputs[0].prompt).toContain("preserve production reliability");
    // The durable goal's stored bot ("codex") must reach engine
    // construction, not just goal metadata.
    expect(factoryBotArgs).toEqual(["codex"]);

    const status = await runAutonomousGoalOperatorStandalone(dbPath, ["status", "standalone-goal"], { engineFactory });
    expect(status).toMatchObject({ goalId: "standalone-goal", status: "complete" });
    // "create" and "status" don't drain anything, so they must not
    // construct an engine at all.
    expect(factoryBotArgs).toEqual(["codex"]);

    removeDb(dbPath);
  });

  it("resolves the real (non-injected) standalone engine's provider from the durable goal's bot, not a hard-coded Claude default", () => {
    const overrideKeys = ["CODEX_COMMAND", "CLAUDE_COMMAND", "ANTIGRAVITY_COMMAND", "GEMINI_COMMAND"] as const;
    const previous = Object.fromEntries(overrideKeys.map((key) => [key, process.env[key]]));
    for (const key of overrideKeys) delete process.env[key];
    try {
      expect(standaloneBotConfig("codex").executionKind).toBe("codex");
      expect(standaloneBotConfig("codex").botConfig.command).toBe("codex");
      expect(standaloneBotConfig("claude").executionKind).toBe("claude");
      expect(standaloneBotConfig("claude").botConfig.command).toBe("claude");
      expect(standaloneBotConfig("antigravity").executionKind).toBe("antigravity");
      expect(standaloneBotConfig("antigravity").botConfig.command).toBe("agy");
    } finally {
      for (const key of overrideKeys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] as string;
      }
    }
  });

  it("honors the same per-bot command env overrides the interactive bridge already uses", () => {
    const previous = process.env.CODEX_COMMAND;
    process.env.CODEX_COMMAND = "/opt/custom/codex";
    try {
      expect(standaloneBotConfig("codex").botConfig.command).toBe("/opt/custom/codex");
    } finally {
      if (previous === undefined) delete process.env.CODEX_COMMAND; else process.env.CODEX_COMMAND = previous;
    }
  });

  it("resolves executionMode the same way the interactive bridge does (per-bot override, then global, then safe default) rather than hard-coding safe", () => {
    const keys = ["CODEX_EXECUTION_MODE", "CLAUDE_EXECUTION_MODE", "BRIDGE_EXECUTION_MODE"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    try {
      // Default: safe.
      expect(standaloneBotConfig("claude").executionMode).toBe("safe");

      // Global override applies to every bot.
      process.env.BRIDGE_EXECUTION_MODE = "trusted";
      expect(standaloneBotConfig("claude").executionMode).toBe("trusted");
      expect(standaloneBotConfig("codex").executionMode).toBe("trusted");

      // Per-bot override wins over the global one.
      process.env.CODEX_EXECUTION_MODE = "safe";
      expect(standaloneBotConfig("codex").executionMode).toBe("safe");
      expect(standaloneBotConfig("claude").executionMode).toBe("trusted");
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] as string;
      }
    }
  });

  it("rejects a bot with no launchable provider command rather than silently defaulting to Claude", () => {
    expect(() => standaloneBotConfig("kimchi" as any)).toThrow(/kimchi/i);
  });

  it("loads the configured Soul exactly as the interactive bridge does — same functions, same env vars (#326)", () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-soul-"));
    const soulPath = join(dir, "company-soul.md");
    writeFileSync(soulPath, [
      "# SOUL.md — Company Agent",
      "",
      "## Identity",
      "",
      "Do smart things.",
      "",
      "## Values",
      "",
      "Outcome over activity.",
      "",
      "## Boundaries",
      "",
      "Initiative is not new authority.",
    ].join("\n"));
    try {
      const context = standaloneSoulContext({ AGENT_BRIDGE_SOUL_PATH: soulPath, AGENT_BRIDGE_SOUL_MODE: "summary" } as any);
      expect(context).toContain("Do smart things.");
      expect(context).toContain("Outcome over activity.");
      expect(context).toContain("Initiative is not new authority.");
      expect(context).not.toContain("[truncated]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when the configured Soul path does not exist, matching loadSoulContext's own fail-open behavior", () => {
    expect(standaloneSoulContext({ AGENT_BRIDGE_SOUL_PATH: "/nonexistent/company-soul.md" } as any)).toBeNull();
  });

  it("passes the resolved Soul context into the real (non-injected) standalone engine construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-soul-engine-"));
    const soulPath = join(dir, "company-soul.md");
    writeFileSync(soulPath, ["# SOUL.md", "", "## Identity", "", "Do smart things."].join("\n"));
    const dbPath = join(dir, "standalone-soul.sqlite");
    const db = openDb(dbPath, { serviceId: "test-standalone-soul-seed", runId: `seed-${Math.random()}` });
    const previous = { AGENT_BRIDGE_SOUL_PATH: process.env.AGENT_BRIDGE_SOUL_PATH, AGENT_BRIDGE_SOUL_MODE: process.env.AGENT_BRIDGE_SOUL_MODE };
    process.env.AGENT_BRIDGE_SOUL_PATH = soulPath;
    process.env.AGENT_BRIDGE_SOUL_MODE = "summary";
    try {
      const engine = buildStandaloneEngine(db, "claude");
      expect((engine as any).opts.soulContext).toContain("Do smart things.");
    } finally {
      if (previous.AGENT_BRIDGE_SOUL_PATH === undefined) delete process.env.AGENT_BRIDGE_SOUL_PATH; else process.env.AGENT_BRIDGE_SOUL_PATH = previous.AGENT_BRIDGE_SOUL_PATH;
      if (previous.AGENT_BRIDGE_SOUL_MODE === undefined) delete process.env.AGENT_BRIDGE_SOUL_MODE; else process.env.AGENT_BRIDGE_SOUL_MODE = previous.AGENT_BRIDGE_SOUL_MODE;
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
