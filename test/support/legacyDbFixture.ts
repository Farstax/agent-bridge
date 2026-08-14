// The fixed, pre-versioned PR #147 legacy-database fixture, extracted from
// test/dbSchema.test.ts into its own side-effect-free module so it can be
// reused by test/support/rolloutFixture.ts (Phase 4C.5, issue #135)
// without pulling in dbSchema.test.ts's own `describe()`/`it()`
// registrations as an import side effect.
import Database from "better-sqlite3";

// All five production entrypoints (index.ts, index-discord-interactive.ts,
// index-health.ts, index-interactive.ts) call the same
// openDb() against the same schema — verified by inspection of each
// entrypoint's openDb() call site. The roles differ only by serviceId and
// database file path, so one fixed legacy-shape fixture is parameterized
// across all five rather than duplicated per role.
export const ROLE_FIXTURES = ["shared", "discord", "health", "interactive"] as const;

/**
 * Fixed pre-versioned SQL modeling the actual legacy on-disk shape observed
 * before schema versioning existed: no user_version marker (defaults to 0),
 * execution_locks missing acquisition_id (triggers the rename-repair),
 * work_items/work_jobs CHECK constraints missing later-added enum values
 * (triggers the rename-recreate repairs), bridge_state/github_links missing
 * later-added columns (triggers the ALTER TABLE ADD COLUMN repairs), and no
 * conversation-persistence or project-memory tables at all (triggers their
 * CREATE TABLE IF NOT EXISTS creation). This is built with raw SQL, not via
 * openDb(), so it stays a stable regression fixture independent of future
 * changes to the migration itself.
 */
export function createLegacyFixture(path: string): void {
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  raw.exec(`
    CREATE TABLE bridge_state (
      chat_id               TEXT    PRIMARY KEY,
      codex_session_id      TEXT,
      gemini_session_id     TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE execution_locks (
      surface     TEXT NOT NULL,
      chat_key    TEXT NOT NULL,
      service_id  TEXT NOT NULL,
      run_id      TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      PRIMARY KEY (surface, chat_key)
    );
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE work_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops')),
      source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','schedule','github','manual')),
      repository  TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE work_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id     INTEGER,
      task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation')),
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','running','waiting_approval','completed','failed','cancelled')),
      bot              TEXT CHECK (bot IN ('codex','antigravity','claude')),
      lease_owner      TEXT,
      lease_expires_at TEXT,
      heartbeat_at     TEXT,
      attempt_count    INTEGER NOT NULL DEFAULT 0,
      max_attempts     INTEGER NOT NULL DEFAULT 2,
      idempotency_key  TEXT NOT NULL UNIQUE,
      input_json       TEXT NOT NULL DEFAULT '{}',
      result_json      TEXT,
      error            TEXT,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id  INTEGER,
      job_id        INTEGER,
      approval_type TEXT NOT NULL CHECK (approval_type IN ('create_issue','start_implementation','push_branch','open_pr','merge_pr','restart_service','cancel_job')),
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
      requested_by  TEXT NOT NULL,
      requested_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      decided_by    TEXT,
      decided_at    TEXT,
      expires_at    TEXT,
      payload_json  TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(work_item_id) REFERENCES work_items(id),
      FOREIGN KEY(job_id) REFERENCES work_jobs(id)
    );
    CREATE TABLE github_links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL,
      repository   TEXT NOT NULL,
      issue_number INTEGER,
      pr_number    INTEGER,
      branch_name  TEXT,
      commit_sha   TEXT,
      remote_url   TEXT,
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(repository, issue_number),
      UNIQUE(repository, pr_number),
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE prompts (
      name        TEXT    PRIMARY KEY,
      prompt_text TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Linked rows across work_items -> work_jobs -> approvals/github_links, with
  // foreign_keys enforcement ON at creation time (matching a real production
  // instance). Exercises the rename-recreate repairs under real FK pressure,
  // not just against an empty schema.
  raw.exec(`
    INSERT INTO bridge_state (chat_id, codex_session_id, gemini_session_id, active_execution_lock, last_update_id)
    VALUES ('chat:legacy', 'codex-session-1', 'gemini-session-1', 0, 42);
    INSERT INTO work_items (id, kind, source, title, status, priority, created_by)
    VALUES (1, 'feature', 'telegram', 'Legacy work item', 'approved', 'normal', 'nick');
    INSERT INTO work_jobs (id, work_item_id, task_type, status, idempotency_key)
    VALUES (1, 1, 'implementation_plan', 'completed', 'legacy-job-1');
    INSERT INTO approvals (id, work_item_id, job_id, approval_type, status, requested_by)
    VALUES (1, 1, 1, 'merge_pr', 'approved', 'nick');
    INSERT INTO github_links (id, work_item_id, repository, pr_number)
    VALUES (1, 1, 'nickconstantinou/agent-bridge', 147);
  `);
  raw.close();
}
