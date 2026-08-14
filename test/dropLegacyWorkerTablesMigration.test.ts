import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations, applyMigrationsUpTo, CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";

const LEGACY_WORKER_TABLES = [
  "work_items",
  "work_jobs",
  "approvals",
  "github_links",
  "feature_plans",
  "work_item_plans",
  "role_assignments",
  "role_assignment_revisions",
] as const;

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function createVersion8Database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  db.pragma("user_version = 8");
  db.exec(`
    INSERT INTO bridge_state (chat_id, codex_session_id) VALUES ('chat:retained', 'session-retained');
    INSERT INTO bridge_runs (run_id, chat_id, bot, status, started_at)
      VALUES ('run-retained', 'chat:retained', 'codex', 'completed', '2026-08-14T00:00:00Z');
    INSERT INTO bridge_events (id, run_id, seq, type, timestamp, payload_json)
      VALUES ('event-retained', 'run-retained', 1, 'run.completed', '2026-08-14T00:00:01Z', '{}');

    INSERT INTO work_items (id, kind, source, title, created_by)
      VALUES (11, 'feature', 'manual', 'obsolete item', 'legacy-worker');
    INSERT INTO work_jobs (id, work_item_id, task_type, idempotency_key)
      VALUES (12, 11, 'feature_plan', 'obsolete-job');
    INSERT INTO approvals (id, work_item_id, job_id, approval_type, requested_by)
      VALUES (13, 11, 12, 'merge_pr', 'legacy-worker');
    INSERT INTO github_links (id, work_item_id, repository, issue_number)
      VALUES (14, 11, 'nickconstantinou/agent-bridge', 409);
    INSERT INTO work_item_plans (id, work_item_id, plan_text)
      VALUES (15, 11, 'obsolete plan');
    INSERT INTO feature_plans (id, chat_id, user_id, brief)
      VALUES (16, 'chat:retained', 'legacy-worker', 'obsolete feature plan');
    INSERT INTO role_assignment_revisions
      (id, scope_key, revision, source, status, idempotency_key)
      VALUES (17, 'chat:retained', 1, 'operator', 'configured_dormant', 'obsolete-role-revision');
    INSERT INTO role_assignments
      (revision_id, role, selection_mode, primary_cli, primary_model)
      VALUES (17, 'technical_lead', 'manual', 'claude', 'obsolete-model');
  `);
  return db;
}

describe("schema version 9 legacy Worker table removal", () => {
  it("removes populated Worker tables while preserving ordinary Run data", () => {
    const db = createVersion8Database();
    const retainedBefore = {
      state: db.prepare("SELECT * FROM bridge_state WHERE chat_id = 'chat:retained'").get(),
      run: db.prepare("SELECT * FROM bridge_runs WHERE run_id = 'run-retained'").get(),
      event: db.prepare("SELECT * FROM bridge_events WHERE id = 'event-retained'").get(),
    };

    applyMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const names = tableNames(db);
    for (const table of LEGACY_WORKER_TABLES) expect(names).not.toContain(table);
    expect(names).toEqual(expect.arrayContaining([
      "bridge_state",
      "bridge_runs",
      "bridge_events",
      "conversation_turns",
      "project_memories",
      "execution_locks",
      "settings",
      "event_receipts",
      "autonomous_goals",
      "reconciliation_audit",
    ]));
    expect(db.prepare("SELECT * FROM bridge_state WHERE chat_id = 'chat:retained'").get()).toEqual(retainedBefore.state);
    expect(db.prepare("SELECT * FROM bridge_runs WHERE run_id = 'run-retained'").get()).toEqual(retainedBefore.run);
    expect(db.prepare("SELECT * FROM bridge_events WHERE id = 'event-retained'").get()).toEqual(retainedBefore.event);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    const legacyObjects = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE name IN (${LEGACY_WORKER_TABLES.map(() => "?").join(",")})
    `).all(...LEGACY_WORKER_TABLES);
    expect(legacyObjects).toEqual([]);
    db.close();
  });

  it("builds a clean schema and treats version 9 as idempotent", () => {
    const db = new Database(":memory:");
    applyMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    for (const table of LEGACY_WORKER_TABLES) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeUndefined();
    }
    const before = tableNames(db);
    applyMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    expect(tableNames(db)).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
