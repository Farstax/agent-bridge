import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, openProductionDb } from "../src/db.js";

describe("shared messaging surface database (#1198)", () => {
  it("opens one interactive DB for all transports and reconciles only the owning surface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-shared-db-"));
    const path = join(dir, "bridge.sqlite");
    const seed = openDb(path, { databaseRole: "interactive" });
    seed.close();

    const telegram = openProductionDb(path, { databaseRole: "interactive", serviceId: "telegram:interactive" });
    const discord = openProductionDb(path, { databaseRole: "interactive", serviceId: "discord:interactive" });
    const slack = openProductionDb(path, { databaseRole: "interactive", serviceId: "slack:interactive" });
    try {
      const insert = telegram.raw.prepare(
        "INSERT INTO bridge_runs (run_id, surface_identity, chat_id, bot, status, started_at) VALUES (?, ?, ?, 'codex', 'running', '2020-01-01T00:00:00Z')",
      );
      insert.run("telegram-run", "telegram:interactive", "123");
      insert.run("discord-run", "discord:interactive", "123");
      insert.run("slack-run", "slack:T1:A1", "123");

      // A live Slack lane with the same raw chat ID must not block recovery
      // of an unrelated Discord conversation.
      const slackLock = slack.acquireLock("slack:T1:A1", "123");
      expect(slackLock).not.toBeNull();

      expect(discord.listRunningRuns("discord:interactive").map(run => run.run_id)).toEqual(["discord-run"]);
      expect(slack.listRunningRuns("slack:T1:A1").map(run => run.run_id)).toEqual(["slack-run"]);

      const reconciled = await discord.reconcileOrphanedRuns({
        candidateRuns: discord.listRunningRuns("discord:interactive"),
        minAgeMs: 0,
        nowMs: Date.parse("2026-11-11T00:00:00Z"),
        processState: () => "absent",
        containmentState: () => "proven",
      });
      expect(reconciled.map(run => run.run_id)).toEqual(["discord-run"]);
      expect(telegram.listRunningRuns("telegram:interactive").map(run => run.run_id)).toEqual(["telegram-run"]);
      expect(slack.listRunningRuns("slack:T1:A1").map(run => run.run_id)).toEqual(["slack-run"]);
      expect(slack.hasExecutionLaneLock("slack:T1:A1", "123")).toBe(true);
    } finally {
      telegram.close();
      discord.close();
      slack.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
