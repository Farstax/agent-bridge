import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db.js";
import { BridgeEngine } from "../src/engine.js";
import {
  AUTONOMOUS_EVENT_KIND,
  AUTONOMOUS_SUPERVISOR_INPUT_KIND,
  createAutonomousGoalIfNoneActive,
  getAutonomousGoal,
  getAutonomousSupervisorState,
  recordAutonomousSupervisorInput,
  recordAutonomousSupervisorMessageId,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";
import { AutonomyController } from "../src/autonomyController.js";
import { matchAutonomousTelegramSupervisorReply, parseAutonomyTelegramCommand } from "../src/autonomyTelegram.js";

function makeDb() {
  const dbPath = join(tmpdir(), `first-class-autonomy-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomy", runId: `process-${Math.random()}` });
  return { db, dbPath };
}
function cleanup(db: ReturnType<typeof openDb>, dbPath: string) { db.close(); try { rmSync(dbPath); } catch {} }
function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}
function declareDisposition(prompt: string, disposition: "continue" | "done" | "blocked", notify = false): void {
  execFileSync(dispositionCommand(prompt), [disposition, ...(notify ? ["--notify"] : [])], { stdio: "pipe" });
}
function mockEngine(db: ReturnType<typeof openDb>, run: (input: any) => Promise<any>) {
  const engine = new BridgeEngine({
    surfaceIdentity: "autonomous", kind: "autonomous", executionKind: "claude",
    botConfig: { command: "claude", modelPreference: ["default"] }, allowedUserIds: new Set(["1"]),
    executionMode: "safe", asyncEnabled: true, pollIntervalMs: 1000,
  }, db, {
    getUpdates: vi.fn(), sendMessage: vi.fn(), sendChatAction: vi.fn(), setMyCommands: vi.fn(),
    answerCallbackQuery: vi.fn(), editMessageText: vi.fn(), sendPhoto: vi.fn(), sendDocument: vi.fn(),
  } as any, { runCliAsync: vi.fn() });
  vi.spyOn(engine, "executeSurfaceNeutralTurn").mockImplementation(run);
  return engine;
}

describe("first-class autonomy (#466)", () => {
  it("rejects Grok as a first-class autonomy provider", async () => {
    const { db, dbPath } = makeDb();
    const dir = mkdtempSync(join(tmpdir(), "autonomy-grok-"));
    writeFileSync(join(dir, "AUTONOMY.md"), "frozen authority");
    const engine = mockEngine(db, async () => {
      throw new Error("grok autonomy must not dispatch");
    });
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      engineForBot: () => engine,
    });
    await expect(controller.start({ bot: "grok" })).rejects.toThrow(/not available for first-class autonomy/i);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get()).toEqual({ count: 0 });
    rmSync(dir, { recursive: true, force: true });
    cleanup(db, dbPath);
  });
  it("atomically creates at most one active Episode and never rebinds its supervisor route", () => {
    const { db, dbPath } = makeDb();
    const first = createAutonomousGoalIfNoneActive(db, {
      goalId: "one", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 3,
      supervisorRoute: { surface: "telegram", address: "10", identity: "20" },
    });
    const second = createAutonomousGoalIfNoneActive(db, {
      goalId: "two", prompt: "different", constraints: [], bot: "codex", maxCycles: 7,
      supervisorRoute: { surface: "telegram", address: "99", identity: "88" },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.goal.goalId).toBe("one");
    expect(getAutonomousSupervisorState(db, "one")?.route).toEqual({ surface: "telegram", address: "10", identity: "20" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals WHERE status = 'active'").get()).toEqual({ count: 1 });
    cleanup(db, dbPath);
  });

  it("never mistakes supervisor_input for a wake and atomically assigns it to the next Run", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "input", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 1 });
    expect(recordAutonomousSupervisorInput(db, { goalId: "input", text: "check the current deployment first", idempotencyKey: "input-1" })).toBe(true);
    const seen: string[] = [];
    const engine = mockEngine(db, async (input) => {
      seen.push(input.prompt);
      declareDisposition(input.prompt, "done");
      return { text: "verified" } as any;
    });
    await runNextAutonomousGoal(db, "input", engine);
    expect(seen[0]).toContain("Supervisor input since previous cycle: check the current deployment first");
    expect(seen[0]).toContain("Prior evidence is continuity, not current truth");
    const receipts = db.raw.prepare("SELECT event_kind, status, run_id FROM event_receipts ORDER BY id").all() as any[];
    expect(receipts.find((r) => r.event_kind === AUTONOMOUS_EVENT_KIND)?.status).toBe("completed");
    const supervisor = receipts.find((r) => r.event_kind === AUTONOMOUS_SUPERVISOR_INPUT_KIND);
    expect(supervisor.status).toBe("completed");
    expect(typeof supervisor.run_id).toBe("string");
    expect(getAutonomousGoal(db, "input").status).toBe("complete");
    cleanup(db, dbPath);
  });

  it("deduplicates repeated supervisor input by its durable idempotency key", () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "duplicate-input", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 2 });
    const input = { goalId: "duplicate-input", text: "same Telegram update", idempotencyKey: "duplicate-key" };
    expect(recordAutonomousSupervisorInput(db, input)).toBe(true);
    expect(recordAutonomousSupervisorInput(db, input)).toBe(true);
    const row = db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE event_kind = ? AND idempotency_key = ?")
      .get(AUTONOMOUS_SUPERVISOR_INPUT_KIND, input.idempotencyKey) as { count: number };
    expect(row.count).toBe(1);
    cleanup(db, dbPath);
  });

  it("does not inject input arriving after claim into the running cycle and retires it at terminal", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "late-input", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 1 });
    const seen: string[] = [];
    const engine = mockEngine(db, async (input) => {
      seen.push(input.prompt);
      expect(recordAutonomousSupervisorInput(db, {
        goalId: "late-input", text: "arrived after claim", idempotencyKey: "late-input-1",
      })).toBe(true);
      declareDisposition(input.prompt, "done");
      return { text: "done" } as any;
    });
    expect(await runNextAutonomousGoal(db, "late-input", engine)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("arrived after claim");
    expect(db.raw.prepare("SELECT status FROM event_receipts WHERE idempotency_key = ?").get("late-input-1"))
      .toEqual({ status: "cancelled" });
    cleanup(db, dbPath);
  });

  it("keeps unclaimed supervisor input out of wake recovery", async () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, { goalId: "wake-filter", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 1 });
    db.raw.prepare("UPDATE event_receipts SET status = 'cancelled' WHERE event_kind = ?").run(AUTONOMOUS_EVENT_KIND);
    recordAutonomousSupervisorInput(db, { goalId: "wake-filter", text: "not a wake", idempotencyKey: "input-only" });
    const called = vi.fn();
    expect(await runNextAutonomousGoal(db, "wake-filter", { executeSurfaceNeutralTurn: called } as any)).toBe(false);
    expect(called).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT status FROM event_receipts WHERE event_kind = ?").get(AUTONOMOUS_SUPERVISOR_INPUT_KIND)).toEqual({ status: "received" });
    cleanup(db, dbPath);
  });

  it("matches only an authenticated reply to a message emitted by the same active Episode", () => {
    const { db, dbPath } = makeDb();
    createAutonomousGoalIfNoneActive(db, {
      goalId: "reply", prompt: "frozen", constraints: [], bot: "claude", maxCycles: 2,
      supervisorRoute: { surface: "telegram", address: "123", identity: "42", thread: "7" },
    });
    recordAutonomousSupervisorMessageId(db, "reply", 900);
    const message: any = { message_id: 901, chat: { id: 123, type: "supergroup" }, from: { id: 42 }, message_thread_id: 7, text: "use option B", reply_to_message: { message_id: 900 } };
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toMatchObject({ goalId: "reply", text: "use option B" });
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, text: "/autonomy stop" })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, from: { id: 43 } })).toBeNull();
    expect(matchAutonomousTelegramSupervisorReply(db, { ...message, reply_to_message: { message_id: 899 } })).toBeNull();
    db.setSetting("autonomy:supervisor:reply", JSON.stringify({
      route: { surface: "telegram", address: "123", identity: "42" }, messageIds: [900],
    }));
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toBeNull();
    db.raw.prepare("UPDATE autonomous_goals SET status = 'complete' WHERE goal_id = 'reply'").run();
    expect(matchAutonomousTelegramSupervisorReply(db, message)).toBeNull();
    cleanup(db, dbPath);
  });

  it("freezes AUTONOMY.md plus start policy, keeps work durable, and does not rewrite an active Episode", async () => {
    const { db, dbPath } = makeDb();
    const dir = mkdtempSync(join(tmpdir(), "autonomy-dir-"));
    writeFileSync(join(dir, "AUTONOMY.md"), "Goal: qualify the current system.\nConstraint: no destructive changes.");
    mkdirSync(join(dir, "work"), { recursive: true });
    writeFileSync(join(dir, "work", "learned-tool.txt"), "keep me");
    let finishRun: ((result: { text: string }) => void) | undefined;
    const neverRun = {
      executeSurfaceNeutralTurn: vi.fn(() => new Promise<{ text: string }>((resolve) => { finishRun = resolve; })
        .finally(() => { finishRun = undefined; })),
    } as any;
    const controller = new AutonomyController({ db, autonomyDir: dir, maxCycles: 20, engineForBot: () => neverRun });
    const first = await controller.start({ bot: "claude", policyInstruction: "Owner approved this Episode.", supervisorRoute: { surface: "telegram", address: "1", identity: "2" } });
    expect(first.created).toBe(true);
    const frozen = getAutonomousGoal(db, first.goal.goalId).prompt;
    expect(frozen).toContain("Goal: qualify the current system.");
    expect(frozen).toContain("Owner approved this Episode.");
    writeFileSync(join(dir, "AUTONOMY.md"), "CHANGED AFTER START");
    const second = await controller.start({ bot: "claude", policyInstruction: "different", supervisorRoute: { surface: "telegram", address: "9" } });
    expect(second.created).toBe(false);
    expect(getAutonomousGoal(db, first.goal.goalId).prompt).toBe(frozen);
    expect(readFileSync(join(dir, "work", "learned-tool.txt"), "utf8")).toBe("keep me");
    await controller.stop("test stop");
    finishRun?.({ text: "stopped" });
    await vi.waitFor(() => expect(finishRun).toBeUndefined());
    rmSync(dir, { recursive: true, force: true });
    cleanup(db, dbPath);
  });

  it("parses the temporary owner policy command without claiming unrelated chat", () => {
    expect(parseAutonomyTelegramCommand("/autonomy approve")).toBe("approve");
    expect(parseAutonomyTelegramCommand("/autonomy@BridgeBot stop", "BridgeBot")).toBe("stop");
    expect(parseAutonomyTelegramCommand("ordinary text")).toBeNull();
  });
});
