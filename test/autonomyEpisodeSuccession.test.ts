import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { AutonomyController } from "../src/autonomyController.js";
import { matchAutonomousTelegramSupervisorReply } from "../src/autonomyTelegram.js";
import { resolveAutonomyRuntimeConfig } from "../src/providerLock.js";

function autonomyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-successor-"));
  writeFileSync(join(dir, "AUTONOMY.md"), "Keep making useful progress toward the durable goal.\n", "utf8");
  return dir;
}

function dispositionCommand(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing autonomy disposition command");
  return JSON.parse(line.slice(prefix.length)) as string;
}

function dispositionEngine(disposition: "continue" | "done" | "blocked", notify = false, text = "bounded result") {
  return {
    executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
      execFileSync(dispositionCommand(input.prompt), [disposition, ...(notify ? ["--notify"] : [])], { stdio: "pipe" });
      return { text, sessionId: null } as any;
    }),
  };
}

function continuingEngine(notify = false) {
  return dispositionEngine("continue", notify, "More useful work remains.");
}

async function eventually(check: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

describe("bounded autonomous Episode succession (#512)", () => {
  it("parses approval policy and daily Episode ceiling while preserving conservative defaults", () => {
    const enabled = resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_DIR: "/tmp/autonomy",
      AGENT_BRIDGE_AUTONOMY_DB_PATH: "/tmp/autonomy.sqlite",
      AGENT_BRIDGE_AUTONOMY_MAX_CYCLES: "7",
      AGENT_BRIDGE_AUTONOMY_REQUIRE_EPISODE_APPROVAL: "false",
      AGENT_BRIDGE_AUTONOMY_MAX_EPISODES_PER_DAY: "2",
    }, null) as any;

    expect(enabled).toMatchObject({
      enabled: true,
      maxCycles: 7,
      requireEpisodeApproval: false,
      maxEpisodesPerDay: 2,
    });

    const defaults = resolveAutonomyRuntimeConfig({
      AGENT_BRIDGE_AUTONOMY_DIR: "/tmp/autonomy",
      AGENT_BRIDGE_AUTONOMY_DB_PATH: "/tmp/autonomy.sqlite",
    }, null) as any;
    expect(defaults.requireEpisodeApproval).toBe(true);
    expect(defaults.maxEpisodesPerDay).toBeGreaterThan(0);
  });

  it("creates one automatic successor after a final continue and stops at the daily Episode ceiling", async () => {
    const dir = autonomyDir();
    const dbPath = join(dir, "autonomy.sqlite");
    const db = openDb(dbPath, { serviceId: "test-autonomy-successor", runId: "process-1" });
    const engine = continuingEngine();
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      requireEpisodeApproval: false,
      maxEpisodesPerDay: 2,
      engineForBot: () => engine as any,
    });

    await controller.start({ bot: "claude" });
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count === 2);
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals WHERE status = 'active'").get() as any).count === 0);

    const rows = db.raw.prepare("SELECT status, cycle FROM autonomous_goals ORDER BY created_at, goal_id").all() as Array<{ status: string; cycle: number }>;
    expect(rows).toEqual([
      { status: "budget_exhausted", cycle: 1 },
      { status: "budget_exhausted", cycle: 1 },
    ]);
    expect(controller.statusText()).toContain("Episodes today 2/2");

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps terminal replies immutable, captures guidance, and injects it once into the successor", async () => {
    const dir = autonomyDir();
    const dbPath = join(dir, "autonomy.sqlite");
    const db = openDb(dbPath, { serviceId: "test-autonomy-reply", runId: "process-2" });
    const engine = continuingEngine(true);
    const deliver = vi.fn().mockResolvedValue(77);
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 3,
      engineForBot: () => engine as any,
      deliverSupervisorMessage: deliver,
    });

    const started = await controller.start({
      bot: "claude",
      supervisorRoute: { surface: "telegram", address: "123", identity: "42", thread: "9" },
    });
    await eventually(() => controller.status().state === "terminal");
    await eventually(() => deliver.mock.calls.length === 1);

    const matched = matchAutonomousTelegramSupervisorReply(db, {
      message_id: 88,
      chat: { id: 123, type: "supergroup" },
      from: { id: 42, first_name: "Owner" },
      message_thread_id: 9,
      text: "For the next Episode, prioritise the release blocker first.",
      reply_to_message: { message_id: 77 },
    } as any)!;

    expect(matched).toMatchObject({
      goalId: started.goal.goalId,
      phase: "successor",
      text: "For the next Episode, prioritise the release blocker first.",
    });
    expect(controller.recordSupervisorInput(matched)).toBe(false);
    expect(controller.status()).toMatchObject({ state: "terminal", goal: { goalId: started.goal.goalId, status: "budget_exhausted" } });

    const successor = await controller.start({ bot: "claude" });
    expect(successor.created).toBe(true);
    await eventually(() => engine.executeSurfaceNeutralTurn.mock.calls.length === 2);
    const successorPrompt = engine.executeSurfaceNeutralTurn.mock.calls[1][0].prompt as string;
    expect(successorPrompt).toContain("Supervisor input since previous cycle: For the next Episode, prioritise the release blocker first.");

    const copied = db.raw.prepare("SELECT COUNT(*) AS count FROM event_receipts WHERE source = 'autonomous' AND event_kind = 'supervisor_input' AND status <> 'received'").get() as { count: number };
    expect(copied.count).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses the configured CLI fallback chain without creating another Episode or Cycle", async () => {
    const dir = autonomyDir();
    const dbPath = join(dir, "autonomy.sqlite");
    const db = openDb(dbPath, { serviceId: "test-autonomy-fallback", runId: "process-3" });
    const claude = { executeSurfaceNeutralTurn: vi.fn().mockRejectedValue(new Error("usage limit reached")) };
    const codex = dispositionEngine("done", false, "fallback completed the work");
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 3,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 3,
      providerChain: ["claude", "codex"],
      engineForBot: (bot) => (bot === "claude" ? claude : codex) as any,
    });

    const started = await controller.start({ bot: "claude" });
    await eventually(() => controller.status().state === "terminal");

    expect(claude.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
    expect(codex.executeSurfaceNeutralTurn).toHaveBeenCalledTimes(1);
    expect(controller.status()).toMatchObject({ state: "terminal", goal: { goalId: started.goal.goalId, status: "complete", cycle: 1 } });
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs").get() as any).count).toBe(1);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
