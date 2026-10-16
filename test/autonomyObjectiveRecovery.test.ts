import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  AUTONOMOUS_EVENT_SOURCE,
  AUTONOMOUS_RUN_SURFACE,
  AUTONOMOUS_SUPERVISOR_INPUT_KIND,
  createAutonomousGoal,
  drainAutonomousGoal,
  getAutonomousGoal,
  recordAutonomousSupervisorInput,
  runNextAutonomousGoal,
} from "../src/autonomousGoalRuntime.js";

// Deterministic end-to-end recovery scenarios (#1021). A failed CI run or a
// refused rollout admission reaches the runtime the way it does in
// production: inside an ordinary, successful provider Run that observes the
// failure and then declares a disposition. The fake world below is the
// external system; its ledgers prove no side effect is duplicated.

function makeDb() {
  const dbPath = join(tmpdir(), `autonomy-objective-recovery-${Date.now()}-${Math.random()}.sqlite`);
  const db = openDb(dbPath, { serviceId: "test-autonomy-objective-recovery", runId: `process-${Math.random()}` });
  return { db, dbPath };
}

function removeDb(dbPath: string) {
  try { rmSync(dbPath); } catch {}
}

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing run-scoped autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function declare(prompt: string, ...args: string[]): void {
  execFileSync(dispositionCommand(prompt), args, { stdio: "pipe" });
}

/** One provider Run per call; `cycle` observes the world, acts, and declares. */
function agent(cycle: (prompt: string) => string) {
  return {
    executeSurfaceNeutralTurn: vi.fn(async (input: any) => ({ text: cycle(input.prompt) })),
  } as any;
}

function wakeReasons(db: BridgeDb): string[] {
  return (db.raw.prepare("SELECT payload_json FROM event_receipts WHERE source = ? AND event_kind = 'goal_wake' ORDER BY id").all(AUTONOMOUS_EVENT_SOURCE) as Array<{ payload_json: string }>)
    .map((row) => JSON.parse(row.payload_json).reason);
}

describe("autonomous objective recovery (#1021)", () => {
  it("failed CI -> repair -> passing CI -> merge keeps the original goal and merges once", async () => {
    const { db, dbPath } = makeDb();
    const world = { ci: "failed" as "failed" | "pending" | "passed", repairs: 0, merges: 0 };
    try {
      createAutonomousGoal(db, { goalId: "ci", prompt: "Merge PR #1 after exact-head CI passes", constraints: [], bot: "claude", maxCycles: 5 });
      const engine = agent((prompt) => {
        if (world.ci === "failed") {
          // A failed gate is not an objective blocker: classless blocked is refused.
          const refused = spawnSync(dispositionCommand(prompt), ["blocked"], { encoding: "utf8" });
          expect(refused.status).toBe(2);
          expect(refused.stderr).toContain("refused rollout admission");
          world.repairs += 1;
          world.ci = "pending";
          declare(prompt, "continue");
          return "CI failed on head A; pushed repair head B; CI is running.";
        }
        if (world.ci === "pending") {
          world.ci = "passed";
          declare(prompt, "continue");
          return "CI still running on head B.";
        }
        if (world.merges === 0) world.merges += 1;
        declare(prompt, "done");
        return "CI passed on head B; merged.";
      });

      await drainAutonomousGoal(db, "ci", engine);

      expect(getAutonomousGoal(db, "ci")).toMatchObject({ status: "complete", cycle: 3 });
      expect(world).toEqual({ ci: "passed", repairs: 1, merges: 1 });
      expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(3);
      expect(wakeReasons(db)).toEqual(["initial", "provider requested continuation", "provider requested continuation"]);
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("failed rollout admission -> repair -> fresh validation -> deployment deploys once and only after validation", async () => {
    const { db, dbPath } = makeDb();
    const ledger: string[] = [];
    let configRepaired = false;
    try {
      createAutonomousGoal(db, { goalId: "rollout", prompt: "Deploy qualified release R", constraints: [], bot: "claude", maxCycles: 4 });
      const engine = agent((prompt) => {
        const admitted = configRepaired;
        ledger.push(admitted ? "validate:admitted" : "validate:refused");
        if (!admitted) {
          configRepaired = true;
          ledger.push("repair:config");
          declare(prompt, "continue");
          return "Rollout admission refused unsupported drop-in; repaired configuration contract.";
        }
        if (!ledger.includes("deploy")) ledger.push("deploy");
        declare(prompt, "done");
        return "Fresh admission passed; deployed R and verified health.";
      });

      await drainAutonomousGoal(db, "rollout", engine);

      expect(getAutonomousGoal(db, "rollout")).toMatchObject({ status: "complete", cycle: 2 });
      expect(ledger).toEqual(["validate:refused", "repair:config", "validate:admitted", "deploy"]);
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("continues across an asynchronous wait and a restart without replaying a side effect", async () => {
    const { db, dbPath } = makeDb();
    const world = { release: "building" as "building" | "published", publishes: 0 };
    let reopened: BridgeDb | null = null;
    try {
      createAutonomousGoal(db, { goalId: "wait", prompt: "Publish release R after its build", constraints: [], bot: "claude", maxCycles: 5 });
      await runNextAutonomousGoal(db, "wait", agent((prompt) => {
        declare(prompt, "continue");
        return "Release build still running; wait.";
      }));
      expect(getAutonomousGoal(db, "wait")).toMatchObject({ status: "active", cycle: 1 });

      // The build finishes, the next cycle publishes, then the process dies
      // after the provider boundary was crossed but before reconciliation.
      const wake = db.raw.prepare("SELECT id FROM event_receipts WHERE source = ? AND status = 'received'").get(AUTONOMOUS_EVENT_SOURCE) as { id: number };
      db.insertRun("crashed-publish", { surfaceIdentity: AUTONOMOUS_RUN_SURFACE, chatKey: "autonomous:wait" }, "claude");
      db.linkEventReceiptRun(wake.id, "crashed-publish");
      world.release = "published";
      world.publishes += 1;
      db.close();

      reopened = openDb(dbPath, { serviceId: "test-autonomy-objective-recovery", runId: "process-after-restart" });
      const prompts: string[] = [];
      const engine = agent((prompt) => {
        prompts.push(prompt);
        if (world.release !== "published") world.publishes += 1;
        declare(prompt, "done");
        return "Observed release R already published; verified checksums.";
      });
      await drainAutonomousGoal(reopened, "wait", engine);

      expect(getAutonomousGoal(reopened, "wait")).toMatchObject({ status: "complete", cycle: 3 });
      expect(world.publishes).toBe(1);
      expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
      expect(prompts[0]).toContain("Original goal: Publish release R after its build");
      expect(prompts[0]).toContain("recoverable execution failure");
      expect(reopened.raw.prepare("SELECT status FROM bridge_runs WHERE run_id = ?").get("crashed-publish")).toEqual({ status: "failed" });
    } finally {
      reopened?.close();
      removeDb(dbPath);
    }
  });

  it("escalates a persistent recoverable failure at the cycle bound", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "persistent", prompt: "Make CI pass", constraints: [], bot: "claude", maxCycles: 3 });
      const engine = agent((prompt) => {
        declare(prompt, "continue");
        return "CI failed again after repair attempt.";
      });

      await drainAutonomousGoal(db, "persistent", engine);

      expect(getAutonomousGoal(db, "persistent")).toMatchObject({ status: "budget_exhausted", cycle: 3 });
      expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(3);
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = ? AND status = 'received'").get(AUTONOMOUS_EVENT_SOURCE)).toEqual({ count: 0 });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("ends the goal immediately for a classified objective blocker and records its class", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "decision", prompt: "Ship the product change", constraints: [], bot: "claude", maxCycles: 5 });
      const engine = agent((prompt) => {
        declare(prompt, "blocked", "decision");
        return "Pricing choice requires an owner decision.";
      });

      await drainAutonomousGoal(db, "decision", engine);

      expect(getAutonomousGoal(db, "decision")).toMatchObject({ status: "blocked", cycle: 1 });
      expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
      expect(db.raw.prepare("SELECT status, error_class FROM event_receipts WHERE source = ? AND event_kind = 'goal_wake'").get(AUTONOMOUS_EVENT_SOURCE))
        .toEqual({ status: "completed", error_class: "escalation_decision" });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it("carries supervisor steering claimed by a failed Run into the recovery cycle", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "steer", prompt: "Deploy release R", constraints: [], bot: "claude", maxCycles: 3 });
      expect(recordAutonomousSupervisorInput(db, { goalId: "steer", text: "do not deploy until the migration is approved", idempotencyKey: "steer-1" })).toBe(true);
      const prompts: string[] = [];
      let calls = 0;
      const engine = {
        executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
          prompts.push(input.prompt);
          calls += 1;
          if (calls === 1) throw new Error("provider exited with code 1");
          declare(input.prompt, "blocked", "decision");
          return { text: "Holding deployment for migration approval." };
        }),
      } as any;

      await drainAutonomousGoal(db, "steer", engine);

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("do not deploy until the migration is approved");
      expect(prompts[1]).toContain("do not deploy until the migration is approved");
      expect(getAutonomousGoal(db, "steer")).toMatchObject({ status: "blocked", cycle: 2 });
      expect(db.raw.prepare("SELECT status FROM event_receipts WHERE source = ? AND event_kind = ?").get(AUTONOMOUS_EVENT_SOURCE, AUTONOMOUS_SUPERVISOR_INPUT_KIND))
        .toEqual({ status: "completed" });
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });

  it.each(["401 Unauthorized", "Invalid API key · Please run /login", "Authentication required"])(
    "escalates provider authentication failure %j as an objective blocker without retrying",
    async (message) => {
      const { db, dbPath } = makeDb();
      try {
        createAutonomousGoal(db, { goalId: "auth", prompt: "Deploy release R", constraints: [], bot: "claude", maxCycles: 3 });
        const engine = { executeSurfaceNeutralTurn: vi.fn(async () => { throw new Error(message); }) } as any;

        await drainAutonomousGoal(db, "auth", engine);

        expect(getAutonomousGoal(db, "auth")).toMatchObject({ status: "blocked", cycle: 1 });
        expect(engine.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
      } finally {
        db.close();
        removeDb(dbPath);
      }
    },
  );

  it("retries a Run that ended without a disposition instead of abandoning the goal", async () => {
    const { db, dbPath } = makeDb();
    try {
      createAutonomousGoal(db, { goalId: "undeclared", prompt: "Finish the task", constraints: [], bot: "claude", maxCycles: 3 });
      let calls = 0;
      const engine = agent((prompt) => {
        calls += 1;
        if (calls === 1) return "Stopped after a failed check without declaring.";
        declare(prompt, "done");
        return "Repaired and verified.";
      });

      await drainAutonomousGoal(db, "undeclared", engine);

      expect(getAutonomousGoal(db, "undeclared")).toMatchObject({ status: "complete", cycle: 2 });
      expect(wakeReasons(db)[1]).toContain("recoverable execution failure");
    } finally {
      db.close();
      removeDb(dbPath);
    }
  });
});
