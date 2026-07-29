import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

const roots: string[] = [];

function runTool(args: string[]): any {
  return JSON.parse(execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/rollout-db.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, AGENT_BRIDGE_DEPLOYER_MODE: "1" },
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("containment-first rollout database path", () => {
  it("allows live bookkeeping at preflight and reconciles it after containment", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-bridge-contained-"));
    roots.push(root);
    const dbPath = join(root, "bridge.sqlite");
    const db = openDb(dbPath);
    for (const runId of ["run-1", "run-2", "run-3"]) db.insertRun(runId, "chat-1", "codex");
    const lane = db.acquireLock("telegram:interactive", "chat-1");
    expect(lane).not.toBeNull();
    db.raw.prepare("UPDATE execution_locks SET run_id = ?").run("run-1");
    db.enqueueMsg("telegram:interactive", "chat-1", {
      prompt: "preserve me", chatId: 1, chatType: "private", attachments: ["/tmp/input.txt"],
    });
    db.raw.prepare(`
      UPDATE pending_messages
      SET state = 'claimed', claim_run_id = ?, claim_acquisition_id = ?, claimed_at = ?
    `).run("run-1", lane!.acquisitionId, new Date().toISOString());
    db.close();

    const before = runTool(["inspect", "--db", dbPath, "--evidence", "-"]);
    expect(before.databases[0]).toMatchObject({
      runningRunCount: 3,
      claimedMessageCount: 1,
      executionLockCount: 1,
      integrity: "ok",
    });

    const reconciled = runTool([
      "reconcile", "--reason", "interrupted_by_controlled_rollout", "--db", dbPath, "--evidence", "-",
    ]);
    expect(reconciled.databases[0].reconciliation).toMatchObject({
      runsInterrupted: 3,
      locksReleased: 1,
      claimsRequeued: 1,
    });

    const raw = new Database(dbPath, { readonly: true });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM bridge_runs WHERE status = 'running'").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM execution_locks").get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT state, prompt, attachments_json FROM pending_messages").get()).toEqual({
      state: "queued",
      prompt: "preserve me",
      attachments_json: '["/tmp/input.txt"]',
    });
    raw.close();
  });
});
