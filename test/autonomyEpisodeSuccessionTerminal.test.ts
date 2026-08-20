import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { AutonomyController } from "../src/autonomyController.js";

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autonomy-terminal-"));
  writeFileSync(join(dir, "AUTONOMY.md"), "Keep progressing the same durable goal.\n", "utf8");
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
    const first = engine("done", "first evidence");
    const second = engine("done", "second evidence");
    let calls = 0;
    const controller = new AutonomyController({
      db,
      autonomyDir: dir,
      maxCycles: 1,
      requireEpisodeApproval: true,
      maxEpisodesPerDay: 5,
      engineForBot: () => (++calls === 1 ? first : second) as any,
    });

    await controller.start({ bot: "claude" });
    await eventually(() => controller.status().state === "terminal");
    const firstGoal = controller.status().goal!;
    await controller.start({ bot: "claude", initialEvidence: ["successor marker"] });
    await eventually(() => (db.raw.prepare("SELECT COUNT(*) AS count FROM autonomous_goals").get() as any).count === 2);

    const rows = db.raw.prepare("SELECT goal_id, created_at FROM autonomous_goals ORDER BY rowid").all() as Array<{ goal_id: string; created_at: string }>;
    db.raw.prepare("UPDATE autonomous_goals SET created_at = ? WHERE goal_id IN (?, ?)").run("2026-08-20 20:00:00", rows[0].goal_id, rows[1].goal_id);
    await eventually(() => controller.status().state === "terminal");
    const latest = controller.status().goal!;

    expect(latest.goalId).not.toBe(firstGoal.goalId);
    expect(latest.evidence).toContain("successor marker");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
