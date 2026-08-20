import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { AutonomyController } from "../src/autonomyController.js";

function makeDir(authority = "Keep progressing the same durable goal."): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-terminal-"));
  writeFileSync(join(dir, "AUTONOMY.md"), `${authority}\n`, "utf8");
  return dir;
}

function commandFrom(prompt: string): string {
  const prefix = "Autonomy disposition command: ";
  const line = prompt.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error("missing disposition command");
  return JSON.parse(line.slice(prefix.length));
}

function engine(disposition: "continue" | "done" | "blocked", text: string) {
  return {
    executeSurfaceNeutralTurn: vi.fn(async (input: any) => {
      execFileSync(commandFrom(input.prompt), [disposition], { stdio: "pipe" });
      return { text, sessionId: null } as any;
    }),
  };
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition did not become true");
}

describe("autonomous Episode terminal boundaries (#512)", () => {
  for (const disposition of ["done", "blocked"] as const) {
    it(`${disposition} never creates an automatic successor`, async () => {
      const dir = makeDir();
      const db = openDb(join(dir, "autonomy.sqlite"), { serviceId: `terminal-${disposition}`, runId: `process-${disposition}` });
      const provider = engine(disposition, `${disposition} evidence`);
      const controller = new AutonomyController({
        db,
        autonomyDir: dir,
        maxCycles: 1,
        requireEpisodeApproval: false,
        maxEpisodesPerDay: 5,
        engineForBot: () => provider as any,
      });

      await controller.start({ bot: "claude" });
      await eventually(() => controller.status().state === "terminal");
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect((db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count).toBe(1);
      expect(controller.status().goal?.status).toBe(disposition === "done" ? "complete" : "blocked");
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("uses insertion order when rapid Episodes share a created_at timestamp", async () => {
    const dir = makeDir();
    const db = openDb(join(dir, "autonomy.sqlite"), { serviceId: "rapid-order", runId: "process-order" });
    const provider = engine("done", "terminal evidence");
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
      engineForBot: () => provider as any,
    });

    await controller.start({ bot: "claude" });
    await eventually(() => controller.status().state === "terminal");
    const firstGoal = controller.status().goal!;
    await controller.start({ bot: "claude", initialEvidence: ["successor marker"] });
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count === 2);

    const rows = db.raw.prepare("SELECT goal_id FROM autonomous_goals ORDER BY rowid").all() as Array<{ goal_id: string }>;
    db.raw.prepare("UPDATE autonomous_goals SET created_at = ? WHERE goal_id IN (?, ?)").run("2026-08-20 20:00:00", rows[0].goal_id, rows[1].goal_id);
    await eventually(() => controller.status().state === "terminal");
    const latest = controller.status().goal!;

    expect(latest.goalId).not.toBe(firstGoal.goalId);
    expect(latest.evidence).toContain("successor marker");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("automatic successors inherit authority without carrying stale owner approval", async () => {
    const dir = makeDir("Durable authority A");
    const db = openDb(join(dir, "autonomy.sqlite"), { serviceId: "authority-auto", runId: "process-authority-auto" });
    const provider = engine("continue", "keep going");
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      requireEpisodeApproval: false,
      maxEpisodesPerDay: 2,
      engineForBot: () => provider as any,
    });

    await controller.start({ bot: "claude", policyInstruction: "Authenticated owner approved Episode 1." });
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count === 2);
    const prompts = db.raw.prepare("SELECT prompt FROM autonomous_goals ORDER BY rowid").all() as Array<{ prompt: string }>;

    expect(prompts[0].prompt).toContain("Authenticated owner approved Episode 1.");
    expect(prompts[1].prompt).toContain("Durable authority A");
    expect(prompts[1].prompt).not.toContain("Authenticated owner approved Episode 1.");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a new Episode after done reads new AUTONOMY.md authority when there is no successor guidance", async () => {
    const dir = makeDir("Goal A");
    const db = openDb(join(dir, "autonomy.sqlite"), { serviceId: "authority-new-goal", runId: "process-authority-new-goal" });
    const provider = engine("done", "goal complete");
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 2,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
      engineForBot: () => provider as any,
    });

    await controller.start({ bot: "claude", policyInstruction: "approve A" });
    await eventually(() => controller.status().state === "terminal");
    writeFileSync(join(dir, "AUTONOMY.md"), "Goal B\n", "utf8");
    await controller.start({ bot: "claude", policyInstruction: "approve B" });
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count === 2);
    const prompts = db.raw.prepare("SELECT prompt FROM autonomous_goals ORDER BY rowid").all() as Array<{ prompt: string }>;

    expect(prompts[0].prompt).toContain("Goal A");
    expect(prompts[1].prompt).toContain("Goal B");
    expect(prompts[1].prompt).not.toContain("Goal A");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
