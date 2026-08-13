import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRoleAssignmentConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { applyLegacyCompatibleBaseline } from "../src/db/legacyBaselineMigration.js";
import { dropLegacyPromptOverrides } from "../src/db/dropLegacyPromptOverridesMigration.js";
import {
  applyMigrationsUpTo,
  CURRENT_SCHEMA_VERSION,
} from "../src/db/schema.js";
import { RoleAssignmentIdempotencyConflictError } from "../src/repositories/roleAssignmentRepository.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bridge-role-assignments-"));
  tempDirs.push(dir);
  return join(dir, "bridge.sqlite");
}

function createVersion2Fixture(path: string): Record<string, unknown[]> {
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  applyMigrationsUpTo(raw, [
    { version: 1, name: "legacy-compatible-baseline", up: applyLegacyCompatibleBaseline },
    { version: 2, name: "drop-empty-legacy-prompt-overrides", up: dropLegacyPromptOverrides },
  ], 2);

  raw.exec(`
    INSERT INTO work_items
      (id, kind, source, repository, title, body, status, priority, created_by)
    VALUES
      (41, 'feature', 'telegram', 'nickconstantinou/agent-bridge',
       'Preserved work item', 'existing body', 'in_progress', 'high', 'operator');

    INSERT INTO work_jobs
      (id, work_item_id, task_type, status, bot, lease_owner, lease_expires_at,
       heartbeat_at, attempt_count, max_attempts, idempotency_key, input_json,
       result_json, phase, phase_data_json)
    VALUES
      (42, 41, 'tdd_implementation', 'running', 'codex', 'worker-1',
       '2030-01-01T00:00:00Z', '2026-07-20T20:00:00Z', 1, 2,
       'existing-job-42', '{"repository":"nickconstantinou/agent-bridge"}',
       '{"state":"preserved"}', 'green', '{"commit":"abc123"}');

    INSERT INTO approvals
      (id, work_item_id, job_id, approval_type, status, requested_by, payload_json)
    VALUES
      (43, 41, 42, 'merge_pr', 'pending', 'worker', '{"pr_number":171}');

    INSERT INTO github_links
      (id, work_item_id, repository, issue_number, pr_number, branch_name,
       commit_sha, remote_url, pr_state, last_activity_at)
    VALUES
      (44, 41, 'nickconstantinou/agent-bridge', 161, 171,
       'agent/issue-161-role-assignment-persistence', 'abc123',
       'https://github.com/nickconstantinou/agent-bridge', 'draft',
       '2026-07-20T20:00:00Z');

    INSERT INTO advisor_calls
      (request_id, scope_key, task_key, mode, trigger, status, context_chars,
       selected_provider, selected_model, confidence)
    VALUES
      ('advisor-existing', 'worker:41', 'issue-161', 'plan', 'manual',
       'succeeded', 1200, 'claude', 'claude-fable-5', 'high');

    INSERT INTO conversation_turns
      (id, chat_key, role, text, cli)
    VALUES
      (45, 'telegram:worker:123', 'user', 'preserved conversation text', 'codex');
  `);

  expect(raw.pragma("user_version", { simple: true })).toBe(2);
  const snapshot = {
    workItems: raw.prepare("SELECT * FROM work_items ORDER BY id").all(),
    workJobs: raw.prepare("SELECT * FROM work_jobs ORDER BY id").all(),
    approvals: raw.prepare("SELECT * FROM approvals ORDER BY id").all(),
    githubLinks: raw.prepare("SELECT * FROM github_links ORDER BY id").all(),
    advisorCalls: raw.prepare("SELECT * FROM advisor_calls ORDER BY request_id").all(),
    conversationTurns: raw.prepare("SELECT * FROM conversation_turns ORDER BY id").all(),
  };
  raw.close();
  return snapshot;
}

function configuredAssignments(model = "gpt-5.6-sol") {
  return loadRoleAssignmentConfig({
    WORKER_ROLE_ASSIGNMENT_SCOPE: "workspace:agent-bridge",
    WORKER_ROLE_ASSIGNMENTS_JSON: JSON.stringify([
      {
        role: "technical_lead",
        selection: "manual",
        primary: { cli: "claude", model: "claude-fable-5" },
        fallbacks: [{ cli: "codex", model: "gpt-5.6-sol" }],
      },
      {
        role: "code_worker",
        selection: "manual",
        primary: { cli: "codex", model },
        fallbacks: [{ cli: "claude", model: "claude-sonnet-5" }],
      },
      {
        role: "documentation_steward",
        selection: "manual",
        primary: { cli: "antigravity", model: "gemini-3.1-pro" },
        fallbacks: [],
      },
    ]),
  })!;
}

function assertFixturePreserved(db: ReturnType<typeof openDb>, snapshot: Record<string, unknown[]>): void {
  expect(db.raw.prepare("SELECT * FROM work_items ORDER BY id").all()).toEqual(snapshot.workItems);
  expect(db.raw.prepare("SELECT * FROM work_jobs ORDER BY id").all()).toEqual(snapshot.workJobs);
  expect(db.raw.prepare("SELECT * FROM approvals ORDER BY id").all()).toEqual(snapshot.approvals);
  expect(db.raw.prepare("SELECT * FROM github_links ORDER BY id").all()).toEqual(snapshot.githubLinks);
  expect(db.raw.prepare("SELECT * FROM advisor_calls ORDER BY request_id").all()).toEqual(snapshot.advisorCalls);
  expect(db.raw.prepare("SELECT * FROM conversation_turns ORDER BY id").all()).toEqual(snapshot.conversationTurns);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("role assignment repository migration", () => {
  it("migrates a representative version-2 database and preserves role revisions across reopen", () => {
    const path = tempDbPath();
    const snapshot = createVersion2Fixture(path);
    const config = configuredAssignments();

    const migrated = openDb(path, { serviceId: "role-assignment-migration-test" });
    expect(migrated.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(7);
    assertFixturePreserved(migrated, snapshot);

    const first = migrated.createRoleAssignmentRevision(config);
    const duplicate = migrated.createRoleAssignmentRevision(config);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({
      scopeKey: "workspace:agent-bridge",
      revision: 1,
      source: "environment",
      status: "configured_dormant",
      assignments: config.assignments,
    });
    expect(migrated.raw.prepare(
      "SELECT COUNT(*) AS count FROM role_assignment_revisions WHERE scope_key = ?",
    ).get(config.scopeKey)).toEqual({ count: 1 });
    expect(migrated.raw.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const reopened = openDb(path, { serviceId: "role-assignment-reopen-test" });
    expect(reopened.raw.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(reopened.getCurrentRoleAssignmentRevision(config.scopeKey)).toEqual(first);
    assertFixturePreserved(reopened, snapshot);
    expect(reopened.raw.pragma("foreign_key_check")).toEqual([]);

    const revisionColumns = (reopened.raw.prepare(
      "PRAGMA table_info(role_assignment_revisions)",
    ).all() as Array<{ name: string }>).map((column) => column.name);
    const assignmentColumns = (reopened.raw.prepare(
      "PRAGMA table_info(role_assignments)",
    ).all() as Array<{ name: string }>).map((column) => column.name);
    const allColumns = [...revisionColumns, ...assignmentColumns];
    for (const forbidden of [
      "token",
      "api_key",
      "secret",
      "prompt_text",
      "repository_content",
    ]) {
      expect(allColumns).not.toContain(forbidden);
    }
    const persisted = JSON.stringify(reopened.getCurrentRoleAssignmentRevision(config.scopeKey));
    expect(persisted).not.toMatch(/token|api[_-]?key|secret|prompt_text|repository_content/i);
    reopened.close();
  });

  it("returns the same revision for an identical idempotency retry and conflicts deterministically for changed input", () => {
    const path = tempDbPath();
    createVersion2Fixture(path);
    const db = openDb(path, { serviceId: "role-assignment-idempotency-test" });
    const original = configuredAssignments();

    const created = db.createRoleAssignmentRevision(original);
    expect(db.createRoleAssignmentRevision(original)).toEqual(created);

    const conflicting = {
      ...configuredAssignments("gpt-5.6-sol-updated"),
      idempotencyKey: original.idempotencyKey,
    };
    try {
      db.createRoleAssignmentRevision(conflicting);
      throw new Error("expected idempotency conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(RoleAssignmentIdempotencyConflictError);
      expect((error as Error).message).not.toContain(original.scopeKey);
      expect((error as Error).message).not.toContain(original.idempotencyKey);
    }
    expect(db.listRoleAssignmentRevisions(original.scopeKey)).toEqual([created]);
    expect(db.raw.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});
