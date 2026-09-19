import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { EventStore } from "../src/events/store.js";
import { type } from "../src/events/types.js";

const roots: string[] = [];

function createDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-bridge-acp-retention-"));
  roots.push(root);
  const path = join(root, "bridge.sqlite");
  const db = openDb(path);
  return { root, path, db };
}

function addRun(
  db: ReturnType<typeof openDb>,
  runId: string,
  status: "running" | "done" | "failed" | "cancelled",
): void {
  db.raw.prepare(`
    INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at, ended_at)
    VALUES (?, 'chat', 'claude', ?, '2026-01-01T00:00:00.000Z', ?)
  `).run(runId, status, status === "running" ? null : "2026-01-01T00:01:00.000Z");
}

function addEvent(
  db: ReturnType<typeof openDb>,
  runId: string,
  seq: number,
  eventType: string,
  timestamp: string,
): void {
  db.raw.prepare(`
    INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
    VALUES (?, ?, ?, ?, ?, '{}')
  `).run(`${runId}:${seq}`, runId, seq, eventType, timestamp);
}

function prune(path: string): any {
  const output = execFileSync(
    process.execPath,
    [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), join(process.cwd(), "scripts", "rollout-db.ts"), "prune", "--evidence", "-", "--db", path],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ACP telemetry retention", () => {
  it("prunes only expired ACP events for terminal runs and is idempotent", () => {
    const { path, db } = createDb();
    addRun(db, "old-done", "done");
    addRun(db, "old-failed", "failed");
    addRun(db, "old-cancelled", "cancelled");
    addRun(db, "old-running", "running");
    addRun(db, "recent-done", "done");

    const old = "2026-01-01T00:00:00.000Z";
    const recent = "2999-01-01T00:00:00.000Z";
    addEvent(db, "old-done", 1, "acp.event", old);
    addEvent(db, "old-done", 2, "run.completed", old);
    addEvent(db, "old-failed", 1, "acp.event", old);
    addEvent(db, "old-cancelled", 1, "acp.event", old);
    addEvent(db, "old-running", 1, "acp.event", old);
    addEvent(db, "recent-done", 1, "acp.event", recent);
    db.close();

    const first = prune(path);
    expect(first.mode).toBe("prune");
    expect(first.databases[0].acpTelemetryRetention.deletedRows).toBe(3);
    expect(first.databases[0].acpTelemetryRetention.pageSize).toBeGreaterThan(0);
    expect(first.databases[0].acpTelemetryRetention.reclaimableBytesAfterDelete).toBeGreaterThanOrEqual(0);

    const reopened = openDb(path);
    const rows = reopened.raw.prepare(
      "SELECT run_id, seq, type FROM bridge_events ORDER BY run_id, seq",
    ).all() as Array<{ run_id: string; seq: number; type: string }>;
    expect(rows).toEqual([
      { run_id: "old-done", seq: 2, type: "run.completed" },
      { run_id: "old-running", seq: 1, type: "acp.event" },
      { run_id: "recent-done", seq: 1, type: "acp.event" },
    ]);
    reopened.close();

    const second = prune(path);
    expect(second.databases[0].acpTelemetryRetention.deletedRows).toBe(0);
  });

  it("preserves active-run event sequencing after retention", () => {
    const { path, db } = createDb();
    addRun(db, "active-run", "running");
    addEvent(db, "active-run", 1, "acp.event", "2026-01-01T00:00:00.000Z");
    db.close();

    prune(path);

    const reopened = openDb(path);
    const store = new EventStore(reopened, "active-run");
    store.collect(type.runDiagnostic({
      runId: "active-run",
      bot: "claude",
      chatId: "chat",
      chatKey: "chat",
      boundary: "provider_execution",
      provider: "claude",
      executionSurface: "acp",
      attempt: 1,
      successorStarted: false,
      retryEligible: false,
      errorName: "TestError",
      message: "bounded diagnostic",
      classification: "unknown",
      fallbackEligible: false,
    }));

    const events = reopened.raw.prepare(
      "SELECT seq, type FROM bridge_events WHERE run_id = ? ORDER BY seq",
    ).all("active-run") as Array<{ seq: number; type: string }>;
    expect(events).toEqual([
      { seq: 1, type: "acp.event" },
      { seq: 2, type: "run.diagnostic" },
    ]);
    reopened.close();
  });
});
