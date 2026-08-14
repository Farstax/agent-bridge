import type Database from "better-sqlite3";

/**
 * Adds a column, tolerating only the specific "already exists" failure so a
 * database that already carries the column (e.g. added by the pre-migration
 * unversioned code path on a real production instance) stays idempotent.
 * Any other failure (disk error, syntax, corruption) propagates so the
 * migration transaction rolls back rather than silently marking an
 * incomplete repair as version 1. Returns whether the column was added.
 */
function addColumnIfMissing(raw: Database.Database, sql: string): boolean {
  try {
    raw.exec(sql);
    return true;
  } catch (err) {
    if (err instanceof Error && /duplicate column name/i.test(err.message)) return false;
    throw err;
  }
}

/**
 * The version-0 to version-1 migration: owns the full legacy DDL and every
 * historical shape-detected repair, transactionally. Moved verbatim out of
 * openDb() so user_version becomes authoritative — a version-1 database no
 * longer re-runs these repairs on every open. Repair failures are allowed to
 * propagate (rather than being caught and logged) so an incomplete repair
 * rolls back the whole migration and leaves user_version at 0, instead of
 * being permanently marked complete.
 */
export function applyLegacyCompatibleBaseline(raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS bridge_state (
      chat_id               TEXT    PRIMARY KEY,
      codex_session_id      TEXT,
      gemini_session_id     TEXT, -- Preserved for legacy session data and backward compatibility
      claude_session_id     TEXT,
      antigravity_session_id TEXT,
      active_execution_lock INTEGER NOT NULL DEFAULT 0,
      last_update_id        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS execution_locks (
      surface     TEXT NOT NULL,
      chat_key    TEXT NOT NULL,
      service_id  TEXT NOT NULL,
      run_id      TEXT NOT NULL,
      acquisition_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      lease_expires_at TEXT NOT NULL,
      PRIMARY KEY (surface, chat_key)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS bridge_runs (
      run_id             TEXT    PRIMARY KEY,
      chat_id            TEXT    NOT NULL,
      bot                TEXT    NOT NULL,
      status             TEXT    NOT NULL,
      started_at         TEXT    NOT NULL,
      ended_at           TEXT,
      session_id         TEXT,
      final_text_preview TEXT,
      error              TEXT
    );
    CREATE TABLE IF NOT EXISTS bridge_events (
      id                 TEXT    PRIMARY KEY,
      run_id             TEXT    NOT NULL,
      seq                INTEGER NOT NULL,
      type               TEXT    NOT NULL,
      timestamp          TEXT    NOT NULL,
      payload_json       TEXT    NOT NULL,
      FOREIGN KEY(run_id) REFERENCES bridge_runs(run_id)
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops','refactor')),
      source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','refactor_scan','schedule','github','manual')),
      repository  TEXT,
      title       TEXT NOT NULL,
      body        TEXT,
      status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
      priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_jobs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id     INTEGER,
      task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','orchestrated_task','refactor_scan','pr_lifecycle','pr_watch','pr_refresh')),
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
    CREATE TABLE IF NOT EXISTS approvals (
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
    CREATE TABLE IF NOT EXISTS github_links (
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
    CREATE TABLE IF NOT EXISTS feature_plans (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('drafting','ready','accepted','cancelled','expired')),
      brief      TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS work_item_plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER NOT NULL UNIQUE,
      plan_text    TEXT NOT NULL,
      quality_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(work_item_id) REFERENCES work_items(id)
    );
    CREATE TABLE IF NOT EXISTS advisor_calls (
      request_id        TEXT PRIMARY KEY,
      scope_key         TEXT NOT NULL,
      turn_key          TEXT,
      task_key          TEXT,
      mode              TEXT NOT NULL,
      trigger           TEXT NOT NULL,
      status            TEXT NOT NULL,
      context_chars     INTEGER NOT NULL DEFAULT 0,
      selected_provider TEXT,
      selected_model    TEXT,
      confidence        TEXT,
      error_kind        TEXT,
      created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_advisor_calls_turn ON advisor_calls(turn_key, status);
    CREATE INDEX IF NOT EXISTS idx_advisor_calls_task ON advisor_calls(task_key, status);
    CREATE TABLE IF NOT EXISTS advisor_attempts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  TEXT NOT NULL,
      ordinal     INTEGER NOT NULL,
      provider    TEXT NOT NULL,
      model       TEXT NOT NULL,
      status      TEXT NOT NULL,
      error_kind  TEXT,
      duration_ms INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(request_id, ordinal),
      FOREIGN KEY(request_id) REFERENCES advisor_calls(request_id)
    );
  `);
  const lockColumns = raw.prepare(`PRAGMA table_info(execution_locks)`).all() as Array<{ name: string }>;
  const requiredLockColumns = new Set(["surface", "chat_key", "service_id", "run_id", "acquisition_id", "acquired_at", "lease_expires_at"]);
  if (!lockColumns.every((column) => requiredLockColumns.has(column.name)) || lockColumns.length !== requiredLockColumns.size) {
    raw.exec(`
      DROP TABLE IF EXISTS execution_locks_legacy_migration;
      ALTER TABLE execution_locks RENAME TO execution_locks_legacy_migration;
      CREATE TABLE execution_locks (
        surface          TEXT NOT NULL,
        chat_key         TEXT NOT NULL,
        service_id       TEXT NOT NULL,
        run_id           TEXT NOT NULL,
        acquisition_id   TEXT NOT NULL,
        acquired_at      TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        PRIMARY KEY (surface, chat_key)
      );
      DROP TABLE execution_locks_legacy_migration;
    `);
  }
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_execution_locks_lease ON execution_locks(lease_expires_at)`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN claude_session_id TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN antigravity_session_id TEXT`);
  raw.exec(`UPDATE bridge_state SET antigravity_session_id = gemini_session_id WHERE antigravity_session_id IS NULL AND gemini_session_id IS NOT NULL`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN codex_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN claude_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN antigravity_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN codex_session_created_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN antigravity_session_created_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN claude_session_created_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN kimchi_session_id TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN kimchi_consecutive_failures INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing(raw, `ALTER TABLE bridge_state ADD COLUMN kimchi_session_created_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE github_links ADD COLUMN pr_state TEXT NOT NULL DEFAULT 'draft'`);
  addColumnIfMissing(raw, `ALTER TABLE github_links ADD COLUMN last_activity_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE github_links ADD COLUMN proof_comment_sha TEXT`);

  const workItemsSql = (raw.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
  ).get() as { sql: string } | undefined)?.sql ?? "";
  const hasCurrentWorkItemTypes = workItemsSql.includes("'refactor'") && workItemsSql.includes("'refactor_scan'");
  if (!hasCurrentWorkItemTypes) {
    // legacy_alter_table (unlike foreign_keys) does take effect inside the
    // enclosing migration transaction; foreign_keys enforcement is already
    // suspended for the whole migration by applyMigrationsUpTo().
    raw.pragma("legacy_alter_table = ON");
    try {
      raw.exec(`
        ALTER TABLE work_items RENAME TO work_items_migrate_tmp;
        CREATE TABLE work_items (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          kind        TEXT NOT NULL CHECK (kind IN ('defect','feature','maintenance','research','ops','refactor')),
          source      TEXT NOT NULL CHECK (source IN ('telegram','health','defect_scan','refactor_scan','schedule','github','manual')),
          repository  TEXT,
          title       TEXT NOT NULL,
          body        TEXT,
          status      TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','needs_approval','approved','in_progress','blocked','resolved','closed','rejected')),
          priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
          created_by  TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO work_items (id, kind, source, repository, title, body, status, priority, created_by, created_at, updated_at)
        SELECT id, kind, source, repository, title, body, status, priority, created_by, created_at, updated_at
        FROM work_items_migrate_tmp;
        DROP TABLE work_items_migrate_tmp;
      `);
    } finally {
      raw.pragma("legacy_alter_table = OFF");
    }
  }

  // Migrate work_jobs task_type CHECK constraint to include feature_plan, pr_lifecycle,
  // pr_watch, pr_refresh, and orchestrated_task. SQLite cannot ALTER CHECK
  // constraints; use rename-recreate. legacy_alter_table prevents SQLite 3.26+
  // from auto-rewriting FK references in other tables (e.g. approvals.job_id)
  // during the rename, which would otherwise cause the DROP TABLE to fail.
  const workJobsSql = (raw.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_jobs'`
  ).get() as { sql: string } | undefined)?.sql ?? "";
  const hasCurrentTaskTypes = workJobsSql.includes("'orchestrated_task'")
    && workJobsSql.includes("'refactor_scan'")
    && workJobsSql.includes("'pr_watch'")
    && workJobsSql.includes("'pr_refresh'");
  if (!hasCurrentTaskTypes) {
    const existingColumns = (raw.prepare(`PRAGMA table_info(work_jobs)`).all() as Array<{ name: string }>)
      .map(c => c.name);
    const hasPhase = existingColumns.includes("phase");
    const hasPhaseData = existingColumns.includes("phase_data_json");
    const baseColumns = [
      "id", "work_item_id", "task_type", "status", "bot", "lease_owner",
      "lease_expires_at", "heartbeat_at", "attempt_count", "max_attempts",
      "idempotency_key", "input_json", "result_json", "error",
      "created_at", "updated_at",
    ];
    const targetColumns = [...baseColumns, "phase", "phase_data_json"].join(", ");
    const sourceColumns = [
      ...baseColumns,
      hasPhase ? "phase" : "'initial'",
      hasPhaseData ? "phase_data_json" : "NULL",
    ].join(", ");
    raw.pragma("legacy_alter_table = ON");
    try {
      raw.exec(`
        ALTER TABLE work_jobs RENAME TO work_jobs_migrate_tmp;
        CREATE TABLE work_jobs (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id     INTEGER,
          task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','orchestrated_task','refactor_scan','pr_lifecycle','pr_watch','pr_refresh')),
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
          phase            TEXT NOT NULL DEFAULT 'initial',
          phase_data_json  TEXT,
          FOREIGN KEY(work_item_id) REFERENCES work_items(id)
        );
        INSERT INTO work_jobs (${targetColumns})
        SELECT ${sourceColumns} FROM work_jobs_migrate_tmp;
        DROP TABLE work_jobs_migrate_tmp;
      `);
    } finally {
      raw.pragma("legacy_alter_table = OFF");
    }
  }

  // Repair legacy DBs where an earlier work_jobs rename left approvals.job_id
  // pointing at a dropped migration table. That blocks merge approval creation.
  const approvalsSql = (raw.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='approvals'`
  ).get() as { sql: string } | undefined)?.sql ?? "";
  if (approvalsSql.includes("work_jobs_old") || approvalsSql.includes("work_jobs_migrate_tmp")) {
    raw.pragma("legacy_alter_table = ON");
    try {
      raw.exec(`
        ALTER TABLE approvals RENAME TO approvals_migrate_tmp;
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
        INSERT INTO approvals (
          id, work_item_id, job_id, approval_type, status, requested_by,
          requested_at, decided_by, decided_at, expires_at, payload_json
        )
        SELECT
          id, work_item_id, job_id, approval_type, status, requested_by,
          requested_at, decided_by, decided_at, expires_at, payload_json
        FROM approvals_migrate_tmp;
        DROP TABLE approvals_migrate_tmp;
      `);
    } finally {
      raw.pragma("legacy_alter_table = OFF");
    }
  }

  // ── Conversation persistence (2026-06-20) ────────────────────────────────
  // conversation_turns are pruned post-/compact via pruneConvTurns(). Summaries are tiny and kept forever.
  // CREATE TABLE/INDEX IF NOT EXISTS already makes this idempotent; a real
  // failure here must propagate rather than be silently swallowed.
  raw.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key   TEXT    NOT NULL,
        role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
        text       TEXT    NOT NULL,
        cli        TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_turns_chat_key ON conversation_turns(chat_key, id);

      CREATE TABLE IF NOT EXISTS pending_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        surface     TEXT    NOT NULL DEFAULT 'legacy',
        chat_key    TEXT    NOT NULL,
        prompt      TEXT    NOT NULL,
        chat_id     INTEGER NOT NULL,
        thread_id   INTEGER,
        chat_type   TEXT    NOT NULL DEFAULT 'private',
        user_id     INTEGER,
        state       TEXT    NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed')),
        claim_run_id TEXT,
        claimed_at  TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key            TEXT    NOT NULL,
        range_start_turn_id INTEGER NOT NULL,
        range_end_turn_id   INTEGER NOT NULL,
        summary_md          TEXT    NOT NULL,
        created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_conv_summaries_chat_key ON conversation_summaries(chat_key, id);

      CREATE TABLE IF NOT EXISTS compaction_attempts (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key              TEXT    NOT NULL,
        trigger               TEXT    NOT NULL CHECK (trigger IN ('manual', 'preseed', 'capacity_fallback')),
        provider              TEXT    NOT NULL,
        model                 TEXT,
        outcome               TEXT    NOT NULL CHECK (outcome IN ('no_turns', 'compacted', 'failed')),
        error_category        TEXT,
        duration_ms           INTEGER NOT NULL,
        chunk_count           INTEGER NOT NULL,
        cli_call_count        INTEGER NOT NULL,
        range_start_turn_id   INTEGER,
        range_end_turn_id     INTEGER,
        started_at            TEXT    NOT NULL,
        ended_at              TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_attempts_chat_key
        ON compaction_attempts(chat_key, id);
    `);
  const migratedPendingSurface = addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN surface TEXT NOT NULL DEFAULT 'legacy'`);
  raw.exec(`CREATE INDEX IF NOT EXISTS idx_pending_msgs_surface_chat_key ON pending_messages(surface, chat_key, id)`);
  addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'claimed'))`);
  addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN claim_run_id TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN claim_acquisition_id TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN claimed_at TEXT`);
  addColumnIfMissing(raw, `ALTER TABLE pending_messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'`);
  if (migratedPendingSurface) {
    const { count } = raw.prepare(`SELECT COUNT(*) AS count FROM pending_messages WHERE surface = 'legacy'`).get() as { count: number };
    if (count > 0) console.warn(`[db] quarantined ${count} legacy pending message(s)`);
  }

  // ── Project memories (2026-06-21) ─────────────────────────────────────────
  raw.exec(`
      CREATE TABLE IF NOT EXISTS project_memories (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL DEFAULT 'project',
        type            TEXT NOT NULL DEFAULT 'decision',
        text            TEXT NOT NULL,
        source_chat_key TEXT,
        source_cli      TEXT,
        source_turn_id  INTEGER,
        source_repo_path TEXT,
        confidence      REAL NOT NULL DEFAULT 1.0,
        created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS project_memories_fts
      USING fts5(id UNINDEXED, text, tokenize='unicode61');
      CREATE TRIGGER IF NOT EXISTS pm_ai AFTER INSERT ON project_memories BEGIN
        INSERT INTO project_memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS pm_ad AFTER DELETE ON project_memories BEGIN
        INSERT INTO project_memories_fts(project_memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS pm_au AFTER UPDATE ON project_memories BEGIN
        INSERT INTO project_memories_fts(project_memories_fts, rowid, id, text) VALUES('delete', old.rowid, old.id, old.text);
        INSERT INTO project_memories_fts(rowid, id, text) VALUES (new.rowid, new.id, new.text);
      END;
    `);
  addColumnIfMissing(raw, `ALTER TABLE project_memories ADD COLUMN source_turn_id INTEGER`);
  addColumnIfMissing(raw, `ALTER TABLE project_memories ADD COLUMN source_repo_path TEXT`);

  // Legacy job checkpoint columns remain readable for old databases. The
  // current runtime does not create, claim, or execute these records.
  addColumnIfMissing(raw, `ALTER TABLE work_jobs ADD COLUMN phase TEXT NOT NULL DEFAULT 'initial'`);
  addColumnIfMissing(raw, `ALTER TABLE work_jobs ADD COLUMN phase_data_json TEXT`);
}
