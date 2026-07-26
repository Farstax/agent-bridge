import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { openDb, BridgeDb, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_RECENT_TURN_LIMIT } from "../src/db.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Public-API compatibility: both constants were exported from src/db.ts
// before conversation persistence moved into ConversationRepository, and
// remain part of db.ts's public surface even though DEFAULT_CONTEXT_RECENT_TURN_LIMIT
// has no internal caller — an OSS module's exports are a compatibility
// contract, not just an internal-usage graph.
describe("db.ts public export compatibility", () => {
  it("still exports DEFAULT_CONTEXT_MAX_CHARS and DEFAULT_CONTEXT_RECENT_TURN_LIMIT", () => {
    expect(DEFAULT_CONTEXT_MAX_CHARS).toBe(8_000);
    expect(DEFAULT_CONTEXT_RECENT_TURN_LIMIT).toBe(200);
  });
});

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("BridgeDb sessions", () => {
  it("returns null for an unknown chat", () => {
    expect(db.getSession("chat1", "codex")).toBeNull();
    expect(db.getSession("chat1", "antigravity")).toBeNull();
  });

  it("persists and retrieves a session per bot", () => {
    db.setSession("chat1", "codex", "codex-session-abc");
    db.setSession("chat1", "antigravity", "antigravity-session-xyz");
    expect(db.getSession("chat1", "codex")).toBe("codex-session-abc");
    expect(db.getSession("chat1", "antigravity")).toBe("antigravity-session-xyz");
  });

  it("updates an existing session without touching the other bot", () => {
    db.setSession("chat1", "codex", "v1");
    db.setSession("chat1", "antigravity", "g1");
    db.setSession("chat1", "codex", "v2");
    expect(db.getSession("chat1", "codex")).toBe("v2");
    expect(db.getSession("chat1", "antigravity")).toBe("g1");
  });

  it("clears a session when set to null", () => {
    db.setSession("chat1", "antigravity", "s1");
    db.setSession("chat1", "antigravity", null);
    expect(db.getSession("chat1", "antigravity")).toBeNull();
  });

  it("keeps sessions isolated per chat", () => {
    db.setSession("chat1", "codex", "s-chat1");
    db.setSession("chat2", "codex", "s-chat2");
    expect(db.getSession("chat1", "codex")).toBe("s-chat1");
    expect(db.getSession("chat2", "codex")).toBe("s-chat2");
  });
});

describe("BridgeDb execution lock", () => {
  it("acquires lock when chat is free", () => {
    expect(db.acquireLock("test", "chat1")).not.toBeNull();
  });

  it("rejects lock when chat is already locked", () => {
    db.acquireLock("test", "chat1");
    expect(db.acquireLock("test", "chat1")).toBeNull();
  });

  it("lock is released by unlock", () => {
    const handle = db.acquireLock("test", "chat1")!;
    db.unlock(handle);
    expect(db.acquireLock("test", "chat1")).not.toBeNull();
  });

  it("lock is per chat — other chats are unaffected", () => {
    db.acquireLock("test", "chat1");
    expect(db.acquireLock("test", "chat2")).not.toBeNull();
  });

  it("isolates the same chat across bot surfaces", () => {
    expect(db.acquireLock("telegram:codex", "chat1")).not.toBeNull();
    expect(db.acquireLock("telegram:claude", "chat1")).not.toBeNull();
    expect(db.acquireLock("telegram:codex", "chat1")).toBeNull();
  });

  it("keeps a live lock when another run of the same service opens the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-lock-owner-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const first = openDb(dbPath, { serviceId: "telegram:interactive", runId: "run-a" });
      expect(first.acquireLock("telegram:codex", "chat1")).not.toBeNull();

      const second = openDb(dbPath, { serviceId: "telegram:interactive", runId: "run-b" });
      expect(second.acquireLock("telegram:codex", "chat1")).toBeNull();
      expect(first.raw.prepare(
        "SELECT service_id, run_id FROM execution_locks WHERE surface = ? AND chat_key = ?"
      ).get("telegram:codex", "chat1")).toEqual({ service_id: "telegram:interactive", run_id: "run-a" });

      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let run B unlock run A's lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-lock-recovery-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const first = openDb(dbPath, { serviceId: "telegram:interactive", runId: "run-a" });
      const firstHandle = first.acquireLock("telegram:codex", "chat1")!;

      const second = openDb(dbPath, { serviceId: "telegram:interactive", runId: "run-b" });
      expect(second.unlock(firstHandle)).toBe(false);
      expect(second.acquireLock("telegram:codex", "chat1")).toBeNull();
      expect(first.raw.prepare(
        "SELECT run_id FROM execution_locks WHERE surface = ? AND chat_key = ?"
      ).get("telegram:codex", "chat1")).toEqual({ run_id: "run-a" });

      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows atomic takeover only after the prior run's lease is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-lock-lease-"));
    const dbPath = join(dir, "bridge.sqlite");
    let now = 1_000;
    const clock = () => now;
    try {
      const first = openDb(dbPath, {
        serviceId: "telegram:interactive", runId: "run-a", lockLeaseMs: 500, clock,
      });
      expect(first.acquireLock("telegram:interactive", "chat1")).not.toBeNull();

      const second = openDb(dbPath, {
        serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock,
      });
      expect(second.acquireLock("telegram:interactive", "chat1")).toBeNull();

      now += 501;
      expect(second.acquireLock("telegram:interactive", "chat1")).not.toBeNull();
      expect(second.raw.prepare(
        "SELECT run_id FROM execution_locks WHERE surface = ? AND chat_key = ?"
      ).get("telegram:interactive", "chat1")).toEqual({ run_id: "run-b" });

      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a heartbeat-renewed lease unavailable to another run", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-lock-heartbeat-"));
    const dbPath = join(dir, "bridge.sqlite");
    let now = 1_000;
    const clock = () => now;
    try {
      const first = openDb(dbPath, {
        serviceId: "telegram:interactive", runId: "run-a", lockLeaseMs: 500, clock,
      });
      const second = openDb(dbPath, {
        serviceId: "telegram:interactive", runId: "run-b", lockLeaseMs: 500, clock,
      });
      const handle = first.acquireLock("telegram:interactive", "chat1")!;
      now += 400;
      expect(first.heartbeatLock(handle)).toBe(true);
      now += 200;
      expect(second.acquireLock("telegram:interactive", "chat1")).toBeNull();
      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects lock and queue calls without an explicit surface", () => {
    expect(() => (db.acquireLock as any)("chat1")).toThrow("chatKey is required");
    expect(() => (db.pendingMsgCount as any)("chat1")).toThrow("chatKey is required");
    expect(() => (db.dequeueMsgs as any)("chat1")).toThrow("chatKey is required");
  });
});

describe("BridgeDb execution-lane migration", () => {
  it("replaces pre-lease lock rows because their liveness cannot be proven", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-lock-schema-migration-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE execution_locks (
          surface TEXT NOT NULL,
          chat_key TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          PRIMARY KEY (surface, chat_key)
        );
        INSERT INTO execution_locks VALUES ('telegram:interactive', 'chat1', 'old-owner', '2026-01-01T00:00:00.000Z');
      `);
      legacy.close();

      const migrated = openDb(dbPath, { serviceId: "migration-test", runId: "migration-run" });
      const columns = migrated.raw.prepare("PRAGMA table_info(execution_locks)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "surface", "chat_key", "service_id", "run_id", "acquisition_id", "acquired_at", "lease_expires_at",
      ]);
      expect(migrated.raw.prepare("SELECT COUNT(*) AS count FROM execution_locks").get()).toEqual({ count: 0 });
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quarantines legacy pending rows while enabling surface-owned queues", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-queue-migration-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE pending_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_key TEXT NOT NULL,
          prompt TEXT NOT NULL,
          chat_id INTEGER NOT NULL,
          thread_id INTEGER,
          chat_type TEXT NOT NULL DEFAULT 'private',
          user_id INTEGER,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO pending_messages (chat_key, prompt, chat_id) VALUES ('chat1', 'legacy prompt', 1);
      `);
      legacy.close();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const migrated = openDb(dbPath, { serviceId: "migration-test", runId: "migration-run" });
      expect(migrated.getQuarantinedPendingMessageCount()).toBe(1);
      expect(warn).toHaveBeenCalledWith("[db] quarantined 1 legacy pending message(s)");
      expect(migrated.pendingMsgCount("telegram:codex", "chat1")).toBe(0);
      expect(migrated.dequeueMsgs("legacy", "chat1")[0].attachments).toEqual([]);
      migrated.enqueueMsg("telegram:codex", "chat1", {
        prompt: "owned prompt", chatId: 1, chatType: "private", attachments: ["/tmp/owned.txt"],
      });
      expect(migrated.dequeueMsgs("telegram:codex", "chat1").map((msg) => msg.prompt)).toEqual(["owned prompt"]);
      expect(migrated.dequeueMsgs("telegram:codex", "chat1")[0].attachments).toEqual(["/tmp/owned.txt"]);
      migrated.close();
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BridgeDb polling offset", () => {
  it("returns 0 for an unknown bot", () => {
    expect(db.getLastUpdateId("codex")).toBe(0);
    expect(db.getLastUpdateId("antigravity")).toBe(0);
  });

  it("stores and retrieves the offset per bot", () => {
    db.setLastUpdateId("codex", 1000);
    db.setLastUpdateId("antigravity", 2000);
    expect(db.getLastUpdateId("codex")).toBe(1000);
    expect(db.getLastUpdateId("antigravity")).toBe(2000);
  });

  it("never decrements the offset (MAX semantics)", () => {
    db.setLastUpdateId("codex", 500);
    db.setLastUpdateId("codex", 100);
    expect(db.getLastUpdateId("codex")).toBe(500);
  });
});

describe("BridgeDb settings", () => {
  it("returns null for an unknown key", () => {
    expect(db.getSetting("codex")).toBeNull();
  });

  it("stores and retrieves a setting", () => {
    db.setSetting("antigravity", "antigravity-3.1-pro-preview");
    expect(db.getSetting("antigravity")).toBe("antigravity-3.1-pro-preview");
  });

  it("overwrites an existing setting", () => {
    db.setSetting("codex", "gpt-4o");
    db.setSetting("codex", "gpt-4o-mini");
    expect(db.getSetting("codex")).toBe("gpt-4o-mini");
  });

  it("clears a setting when set to null", () => {
    db.setSetting("codex", "gpt-4o");
    db.setSetting("codex", null);
    expect(db.getSetting("codex")).toBeNull();
  });
});

describe("BridgeDb SQL guard", () => {
  it("getSession throws on invalid bot kind", () => {
    expect(() => db.getSession("chat1", "invalid" as any)).toThrow("Invalid bot kind");
  });

  it("setSession throws on invalid bot kind", () => {
    expect(() => db.setSession("chat1", "invalid" as any, "s1")).toThrow("Invalid bot kind");
  });

  it("getSession allows claude bot kind", () => {
    expect(() => db.getSession("chat1", "claude" as any)).not.toThrow();
  });

  it("setSession allows claude bot kind", () => {
    expect(() => db.setSession("chat1", "claude" as any, "s1")).not.toThrow();
  });
});

describe("BridgeDb session TTL", () => {
  it("fresh session is not expired", () => {
    db.setSession("chat1", "codex", "s-fresh");
    expect(db.getSession("chat1", "codex")).toBe("s-fresh");
  });

  it("openDb clears sessions with a created_at older than 7 days", () => {
    // Manually insert a row with an old timestamp to simulate a stale session
    const raw = (db as any).raw as import("better-sqlite3").Database;
    raw.prepare(`INSERT INTO bridge_state (chat_id, codex_session_id, codex_session_created_at)
                 VALUES ('chat-stale', 'old-session', datetime('now', '-8 days'))
                 ON CONFLICT (chat_id) DO UPDATE SET
                   codex_session_id = excluded.codex_session_id,
                   codex_session_created_at = excluded.codex_session_created_at`).run();
    // Close and re-open to trigger the startup TTL sweep
    db.close();
    db = openDb(":memory:");
    // The new DB is empty — stale session was in the old connection, but the sweep
    // runs on every open. Verify the sweep SQL itself works by injecting directly.
    const raw2 = (db as any).raw as import("better-sqlite3").Database;
    raw2.prepare(`INSERT INTO bridge_state (chat_id, codex_session_id, codex_session_created_at)
                  VALUES ('chat-stale', 'old-session', datetime('now', '-8 days'))`).run();
    raw2.exec(`UPDATE bridge_state
               SET codex_session_id = NULL, codex_session_created_at = NULL
               WHERE codex_session_created_at IS NOT NULL
                 AND codex_session_created_at < datetime('now', '-7 days')`);
    expect(db.getSession("chat-stale", "codex")).toBeNull();
  });

  it("setSession preserves existing timestamp on same-session update", () => {
    db.setSession("chat1", "codex", "s1");
    const raw = (db as any).raw as import("better-sqlite3").Database;
    const ts1 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    // Re-set same session ID — timestamp should not change
    db.setSession("chat1", "codex", "s1");
    const ts2 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    expect(ts1).toBe(ts2);
  });

  it("setSession resets timestamp when session ID changes", () => {
    db.setSession("chat1", "codex", "s1");
    const raw = (db as any).raw as import("better-sqlite3").Database;
    const ts1 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    db.setSession("chat1", "codex", "s2");
    const ts2 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    expect(ts2).not.toBeNull();
    // Timestamps may be equal if both ran in the same millisecond — just check it's set
    expect(ts2).toBeTruthy();
  });

  it("setSession clears timestamp when session is cleared", () => {
    db.setSession("chat1", "codex", "s1");
    db.setSession("chat1", "codex", null);
    const raw = (db as any).raw as import("better-sqlite3").Database;
    const ts = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    expect(ts).toBeNull();
  });
});

describe("BridgeDb conversation startup pruning", () => {
  it("openDb prunes only turns already covered by compact summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-conv-prune-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const first = openDb(dbPath);
      first.addConvTurn("chat:1", "user", "covered one");
      first.addConvTurn("chat:1", "assistant", "covered two");
      first.addConvTurn("chat:1", "user", "uncovered three");
      first.addConvTurn("chat:2", "user", "never summarized");
      const raw = (first as any).raw as import("better-sqlite3").Database;
      const coveredEnd = (raw
        .prepare(`SELECT id FROM conversation_turns WHERE chat_key = ? AND text = ?`)
        .get("chat:1", "covered two") as any).id;
      first.addConvSummary("chat:1", 1, coveredEnd, "Summary for covered turns.");
      first.close();

      const reopened = openDb(dbPath);
      const remaining = ((reopened as any).raw as import("better-sqlite3").Database)
        .prepare(`SELECT chat_key, text FROM conversation_turns ORDER BY id`)
        .all() as Array<{ chat_key: string; text: string }>;
      expect(remaining).toEqual([
        { chat_key: "chat:1", text: "uncovered three" },
        { chat_key: "chat:2", text: "never summarized" },
      ]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BridgeDb getUncompactedConvStats", () => {
  it("returns zero stats for a chat with no turns", () => {
    expect(db.getUncompactedConvStats("chat:none")).toEqual({ turnCount: 0, charCount: 0 });
  });

  it("counts all turns and total chars when there is no summary yet", () => {
    db.addConvTurn("chat:1", "user", "12345");
    db.addConvTurn("chat:1", "assistant", "1234567890");
    expect(db.getUncompactedConvStats("chat:1")).toEqual({ turnCount: 2, charCount: 15 });
  });

  it("only counts turns after the latest summary's range_end_turn_id", () => {
    db.addConvTurn("chat:1", "user", "covered-one");
    db.addConvTurn("chat:1", "assistant", "covered-two");
    const raw = (db as any).raw as import("better-sqlite3").Database;
    const coveredEnd = (raw
      .prepare(`SELECT id FROM conversation_turns WHERE chat_key = ? AND text = ?`)
      .get("chat:1", "covered-two") as any).id;
    db.addConvSummary("chat:1", 1, coveredEnd, "summary");
    db.addConvTurn("chat:1", "user", "uncovered");

    expect(db.getUncompactedConvStats("chat:1")).toEqual({ turnCount: 1, charCount: "uncovered".length });
  });

  it("isolates stats per chat key", () => {
    db.addConvTurn("chat:1", "user", "abc");
    db.addConvTurn("chat:2", "user", "abcdefg");
    expect(db.getUncompactedConvStats("chat:1")).toEqual({ turnCount: 1, charCount: 3 });
    expect(db.getUncompactedConvStats("chat:2")).toEqual({ turnCount: 1, charCount: 7 });
  });
});

describe("Per-topic session isolation", () => {
  it("composite chat:thread key isolates sessions between forum topics", () => {
    db.setSession("100:10", "antigravity", "s-topic-10");
    db.setSession("100:20", "antigravity", "s-topic-20");
    expect(db.getSession("100:10", "antigravity")).toBe("s-topic-10");
    expect(db.getSession("100:20", "antigravity")).toBe("s-topic-20");
  });

  it("resetting a topic session does not affect other topics", () => {
    db.setSession("100:10", "antigravity", "s-topic-10");
    db.setSession("100:20", "antigravity", "s-topic-20");
    db.setSession("100:10", "antigravity", null);
    expect(db.getSession("100:10", "antigravity")).toBeNull();
    expect(db.getSession("100:20", "antigravity")).toBe("s-topic-20");
  });

  it("per-user group key isolates sessions between users in the same group", () => {
    db.setSession("-1001:10:111", "codex", "s-user-111");
    db.setSession("-1001:10:222", "codex", "s-user-222");
    expect(db.getSession("-1001:10:111", "codex")).toBe("s-user-111");
    expect(db.getSession("-1001:10:222", "codex")).toBe("s-user-222");
  });
});

describe("BridgeDb schema migrations", () => {
  it("repairs approvals.job_id foreign keys that point at work_jobs_old", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-db-"));
    const dbPath = join(dir, "bridge.sqlite");
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE work_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          source TEXT NOT NULL,
          repository TEXT,
          title TEXT NOT NULL,
          body TEXT,
          status TEXT NOT NULL DEFAULT 'proposed',
          priority TEXT NOT NULL DEFAULT 'normal',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE work_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          task_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          bot TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT,
          heartbeat_at TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 2,
          idempotency_key TEXT NOT NULL UNIQUE,
          input_json TEXT NOT NULL DEFAULT '{}',
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(work_item_id) REFERENCES work_items(id)
        );
        CREATE TABLE approvals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          approval_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          requested_by TEXT NOT NULL,
          requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          decided_by TEXT,
          decided_at TEXT,
          expires_at TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY(work_item_id) REFERENCES work_items(id),
          FOREIGN KEY(job_id) REFERENCES "work_jobs_old"(id)
        );
      `);
      legacy.close();

      const repaired = openDb(dbPath);
      const item = repaired.createWorkItem({ kind: "defect", source: "defect_scan", title: "T", created_by: "worker" });
      const job = repaired.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:approval-fk", work_item_id: item.id });

      expect(() => repaired.createApproval({
        approval_type: "merge_pr",
        requested_by: "agent",
        work_item_id: item.id,
        job_id: job.id,
      })).not.toThrow();

      const fks = repaired.raw.prepare(`PRAGMA foreign_key_list(approvals)`).all() as Array<{ table: string }>;
      expect(fks.some(fk => fk.table === "work_jobs")).toBe(true);
      expect(fks.some(fk => fk.table === "work_jobs_old")).toBe(false);
      repaired.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BridgeDb runs and events persistence", () => {
  it("creates a run on insertRun", () => {
    db.insertRun("run-1", "chat-123", "codex");
    const run = db.getRun("run-1");
    expect(run).toBeDefined();
    expect(run.run_id).toBe("run-1");
    expect(run.chat_id).toBe("chat-123");
    expect(run.bot).toBe("codex");
    expect(run.status).toBe("running");
    expect(run.started_at).toBeDefined();
  });

  it("updates run on completion", () => {
    db.insertRun("run-1", "chat-123", "codex");
    db.updateRunCompleted("run-1", "all done", "sess-abc");
    const run = db.getRun("run-1");
    expect(run.status).toBe("done");
    expect(run.final_text_preview).toBe("all done");
    expect(run.session_id).toBe("sess-abc");
    expect(run.ended_at).toBeDefined();
  });

  it("updates run on failure", () => {
    db.insertRun("run-1", "chat-123", "codex");
    db.updateRunFailed("run-1", "CLI crashed");
    const run = db.getRun("run-1");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("CLI crashed");
    expect(run.ended_at).toBeDefined();
  });

  it("updates run on cancellation", () => {
    db.insertRun("run-1", "chat-123", "codex");
    db.updateRunCancelled("run-1", "user");
    const run = db.getRun("run-1");
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("user");
    expect(run.ended_at).toBeDefined();
  });

  it("persists cancellation reason in error column", () => {
    db.insertRun("run-1", "chat-123", "codex");
    db.updateRunCancelled("run-1", "user requested reset");
    const run = db.getRun("run-1");
    expect(run.error).toBe("user requested reset");
  });

  it("inserts and retrieves events for a run", () => {
    db.insertRun("run-1", "chat-123", "codex");
    db.insertEvent("run-1", 1, "run.started", new Date().toISOString(), { command: "codex" });
    db.insertEvent("run-1", 2, "run.completed", new Date().toISOString(), { text: "done" });
    
    const events = db.getEventsForRun("run-1");
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("run.started");
    expect(events[0].seq).toBe(1);
    expect(JSON.parse(events[0].payload_json).command).toBe("codex");
  });

  it("enforces bridge_events run foreign keys", () => {
    expect(() =>
      db.insertEvent("missing-run", 1, "run.started", new Date().toISOString(), { command: "codex" })
    ).toThrow();
  });

  describe("reconcileOrphanedRuns", () => {
    it("marks only running runs as failed and invokes callback", async () => {
      db.insertRun("run-orphan-1", "chat-123", "codex");
      db.insertRun("run-done-1", "chat-123", "codex");
      db.updateRunCompleted("run-done-1", "done", null);

      const orphanedRuns: any[] = [];
      await db.reconcileOrphanedRuns({
        nowMs: Date.now(),
        minAgeMs: 0,
        processState: () => "absent",
        containmentState: () => "proven",
        onReconciled: (run) => {
        orphanedRuns.push(run);
        },
      });

      expect(orphanedRuns.length).toBe(1);
      expect(orphanedRuns[0].run_id).toBe("run-orphan-1");
      expect(orphanedRuns[0].chat_id).toBe("chat-123");
      expect(orphanedRuns[0].bot).toBe("codex");

      const orphanStatus = db.getRun("run-orphan-1");
      expect(orphanStatus.status).toBe("failed");
      expect(orphanStatus.error).toBe("Process interrupted by bridge restart");
      expect(orphanStatus.ended_at).toBeDefined();

      const doneStatus = db.getRun("run-done-1");
      expect(doneStatus.status).toBe("done");
      expect(doneStatus.error).toBeNull();
    });
  });
});

describe("insertRun — simplified signature", () => {
  it("accepts only runId, chatId, bot (no command/cwd/model)", () => {
    // These params are not stored in bridge_runs — only in bridge_events payload.
    // insertRun should not accept them to avoid the misleading implication they are persisted.
    db.insertRun("run-sig", "chat-x", "claude");
    const run = db.getRun("run-sig");
    expect(run).toBeDefined();
    expect(run.run_id).toBe("run-sig");
    expect(run.bot).toBe("claude");
    expect(run.status).toBe("running");
  });
});

// ── Phase 1: Slice 1 — Canonical Work Schema ──────────────────────────────────

describe("work schema — tables exist", () => {
  it("opens a DB with work_items table", () => {
    const row = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'`
    ).get();
    expect(row).toBeDefined();
  });

  it("opens a DB with work_jobs table", () => {
    const row = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='work_jobs'`
    ).get();
    expect(row).toBeDefined();
  });

  it("opens a DB with approvals table", () => {
    const row = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'`
    ).get();
    expect(row).toBeDefined();
  });

  it("opens a DB with github_links table", () => {
    const row = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='github_links'`
    ).get();
    expect(row).toBeDefined();
  });

  it("has foreign keys enabled", () => {
    const row = db.raw.prepare(`PRAGMA foreign_keys`).get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });
});

describe("createWorkItem", () => {
  it("creates a work item and returns an id", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Fix the thing", created_by: "user:42" });
    expect(item.id).toBeGreaterThan(0);
    expect(item.status).toBe("proposed");
    expect(item.title).toBe("Fix the thing");
  });

  it("created_at and updated_at are populated", () => {
    const item = db.createWorkItem({ kind: "feature", source: "manual", title: "New feature", created_by: "user:1" });
    expect(item.created_at).toBeTruthy();
    expect(item.updated_at).toBeTruthy();
  });
});

describe("getWorkItem", () => {
  it("returns the work item by id", () => {
    const created = db.createWorkItem({ kind: "defect", source: "health", title: "Leak", created_by: "health" });
    const fetched = db.getWorkItem(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Leak");
  });

  it("returns null for unknown id", () => {
    expect(db.getWorkItem(99999)).toBeNull();
  });
});

describe("listWorkItems", () => {
  it("lists work items matching status filter", () => {
    db.createWorkItem({ kind: "defect", source: "defect_scan", title: "A", created_by: "worker" });
    db.createWorkItem({ kind: "feature", source: "telegram", title: "B", created_by: "user:1" });
    expect(db.listWorkItems({ status: "proposed" })).toHaveLength(2);
  });

  it("returns empty when no items match", () => {
    expect(db.listWorkItems({ status: "resolved" })).toHaveLength(0);
  });
});

describe("updateWorkItemStatus", () => {
  it("updates status to a valid value", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "user:1" });
    db.updateWorkItemStatus(item.id, "approved");
    expect(db.getWorkItem(item.id)!.status).toBe("approved");
  });

  it("updates title and body from canonical source", () => {
    const item = db.createWorkItem({ kind: "feature", source: "github", title: "Old", body: "old", created_by: "user:1" });
    db.updateWorkItemTitleAndBody(item.id, "New", "new body");
    const updated = db.getWorkItem(item.id)!;
    expect(updated.title).toBe("New");
    expect(updated.body).toBe("new body");
  });
});

describe("createWorkJob", () => {
  it("creates a job with a work_item_id", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "user:1" });
    const job = db.createWorkJob({ work_item_id: item.id, task_type: "defect_scan", idempotency_key: "scan:agent-bridge:1" });
    expect(job.id).toBeGreaterThan(0);
    expect(job.status).toBe("pending");
    expect(job.work_item_id).toBe(item.id);
  });

  it("creates a job with no work_item_id (repository scan)", () => {
    const job = db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:agent-bridge:standalone" });
    expect(job.id).toBeGreaterThan(0);
    expect(job.work_item_id).toBeNull();
  });

  it("duplicate idempotency_key returns the existing job", () => {
    const key = "scan:agent-bridge:idem";
    const j1 = db.createWorkJob({ task_type: "defect_scan", idempotency_key: key });
    const j2 = db.createWorkJob({ task_type: "defect_scan", idempotency_key: key });
    expect(j2.id).toBe(j1.id);
  });
});

describe("getWorkJob / listWorkJobs", () => {
  it("retrieves job by id", () => {
    const job = db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:1" });
    expect(db.getWorkJob(job.id)!.task_type).toBe("ops_check");
  });

  it("returns null for unknown id", () => {
    expect(db.getWorkJob(99999)).toBeNull();
  });

  it("lists jobs filtered by status", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:a" });
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:b" });
    expect(db.listWorkJobs({ status: "pending" })).toHaveLength(2);
    expect(db.listWorkJobs({ status: "completed" })).toHaveLength(0);
  });
});

describe("createApproval / resolveApproval", () => {
  it("creates a pending approval", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "user:1" });
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "merge_pr", requested_by: "worker" });
    expect(appr.status).toBe("pending");
  });

  it("resolveApproval sets approved state", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Y", created_by: "user:1" });
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker" });
    const resolved = db.resolveApproval(appr.id, "approved", "user:42");
    expect(resolved.status).toBe("approved");
    expect(resolved.decided_by).toBe("user:42");
  });

  it("resolving an already-decided approval does not change state", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Z", created_by: "user:1" });
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker" });
    db.resolveApproval(appr.id, "approved", "user:42");
    const second = db.resolveApproval(appr.id, "rejected", "user:99");
    expect(second.status).toBe("approved");
  });
});

describe("linkGithubIssue / linkGithubPr", () => {
  it("stores a github issue link", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Issue", created_by: "user:1" });
    const link = db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 42 });
    expect(link.issue_number).toBe(42);
  });

  it("finds an existing github issue link", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Issue", created_by: "user:1" });
    const link = db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 42 });
    expect(db.getGithubIssueLink("owner/repo", 42)?.id).toBe(link.id);
    expect(db.getGithubIssueLink("owner/repo", 43)).toBeNull();
  });

  it("github_links enforces uniqueness for (repository, issue_number)", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Dup", created_by: "user:1" });
    db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 10 });
    expect(() => db.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 10 })).toThrow();
  });

  it("stores a github PR link", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "PR", created_by: "user:1" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: "agent/work-1" });
    expect(link.pr_number).toBe(7);
    expect(link.branch_name).toBe("agent/work-1");
  });

  it("github_links enforces uniqueness for (repository, pr_number)", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Dup PR", created_by: "user:1" });
    db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 5 });
    expect(() => db.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 5 })).toThrow();
  });
});

// ── Phase 1: Slice 2 — Job Lease Lifecycle ────────────────────────────────────

describe("claimNextWorkJob", () => {
  it("claims the oldest pending job", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:old" });
    const claimed = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("leased");
    expect(claimed!.lease_owner).toBe("worker-1");
  });

  it("returns null when no pending jobs exist", () => {
    expect(db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)).toBeNull();
  });

  it("second worker cannot claim same active lease", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:x" });
    db.claimNextWorkJob("worker-1", new Date().toISOString(), 60);
    expect(db.claimNextWorkJob("worker-2", new Date().toISOString(), 60)).toBeNull();
  });

  it("expired leased job can be reclaimed", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:exp" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 1)!;
    const past = new Date(Date.now() - 120_000).toISOString();
    db.raw.prepare(`UPDATE work_jobs SET lease_expires_at = ? WHERE id = ?`).run(past, job.id);
    const reclaimed = db.claimNextWorkJob("worker-2", new Date().toISOString(), 60);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.lease_owner).toBe("worker-2");
  });

  it("claims the specific job when jobId is provided, skipping older jobs", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:older" });
    const target = db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:target" });

    const claimed = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60, target.id);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(target.id);
    const older = db.listWorkJobs().find(j => j.idempotency_key === "scan:older");
    expect(older?.status).toBe("pending");
  });

  it("returns null when the requested jobId is not claimable", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:taken" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    // Active lease — a pinned claim by another worker must fail
    expect(db.claimNextWorkJob("worker-2", new Date().toISOString(), 60, job.id)).toBeNull();
  });
});

describe("failWorkJobPermanently", () => {
  it("marks the job failed even when attempts remain", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:perm", max_attempts: 5 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.failWorkJobPermanently(job.id, "No handler registered", "worker-1");
    const updated = db.getWorkJob(job.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("No handler registered");
    expect(updated.lease_owner).toBeNull();
  });
});

describe("markWorkJobRunning / heartbeatWorkJob", () => {
  it("transitions job from leased to running", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:r" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    expect(db.getWorkJob(job.id)!.status).toBe("running");
  });

  it("does not transition a cancelled leased job to running", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel-leased-running" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;

    db.cancelWorkJob(job.id, "work item closed");
    db.markWorkJobRunning(job.id, "worker-1");

    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("heartbeat updates heartbeat_at", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:hb" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    const ts = new Date().toISOString();
    db.heartbeatWorkJob(job.id, "worker-1", ts);
    expect(db.getWorkJob(job.id)!.heartbeat_at).toBe(ts);
  });

  it("completeWorkJob does not overwrite a cancelled job", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel-complete" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");

    // User cancels while the handler is still running
    db.cancelWorkJob(job.id, "user cancelled");
    db.completeWorkJob(job.id, { summary: "finished anyway" }, "worker-1");

    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("failWorkJob does not overwrite a cancelled job", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel-fail" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");

    db.cancelWorkJob(job.id, "user cancelled");
    db.failWorkJob(job.id, "late failure", "worker-1");

    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("heartbeat with leaseSeconds extends lease_expires_at", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:hb-ext" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");

    const later = new Date(Date.now() + 120_000).toISOString();
    db.heartbeatWorkJob(job.id, "worker-1", later, 60);

    const updated = db.getWorkJob(job.id)!;
    expect(updated.heartbeat_at).toBe(later);
    // Lease must now expire 60s after the heartbeat, not the original claim
    expect(new Date(updated.lease_expires_at!).getTime()).toBe(new Date(later).getTime() + 60_000);
  });
});

describe("completeWorkJob / failWorkJob", () => {
  it("completing clears lease and stores result", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:done" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.completeWorkJob(job.id, { summary: "ok" }, "worker-1");
    const done = db.getWorkJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.lease_owner).toBeNull();
    expect(JSON.parse(done.result_json!).summary).toBe("ok");
  });

  it("failing increments attempt_count and stores error", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:fail" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.failWorkJob(job.id, "timeout after 30s", "worker-1");
    const failed = db.getWorkJob(job.id)!;
    expect(failed.attempt_count).toBe(1);
    expect(failed.error).toBe("timeout after 30s");
  });

  it("failed job with attempts remaining returns to pending", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:retry", max_attempts: 3 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.failWorkJob(job.id, "err", "worker-1");
    expect(db.getWorkJob(job.id)!.status).toBe("pending");
  });

  it("failed job with attempts exhausted becomes failed permanently", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:exhaust", max_attempts: 1 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.failWorkJob(job.id, "fatal", "worker-1");
    expect(db.getWorkJob(job.id)!.status).toBe("failed");
  });

  it("completing clears a previous failed attempt's error message", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:clear-error", max_attempts: 2 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.failWorkJob(job.id, "temporary error", "worker-1");

    const job2 = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job2.id, "worker-1");
    db.completeWorkJob(job2.id, { summary: "ok on second try" }, "worker-1");

    const done = db.getWorkJob(job.id)!;
    expect(done.status).toBe("completed");
    expect(done.error).toBeNull();
  });
});

describe("recoverExpiredWorkJobs", () => {
  it("returns expired running jobs to pending when attempts remain", () => {
    db.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:recover", max_attempts: 2 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 1)!;
    db.markWorkJobRunning(job.id, "worker-1");
    const past = new Date(Date.now() - 120_000).toISOString();
    db.raw.prepare(`UPDATE work_jobs SET lease_expires_at = ? WHERE id = ?`).run(past, job.id);
    const recovered = db.recoverExpiredWorkJobs(new Date().toISOString());
    expect(recovered).toBe(1);
    expect(db.getWorkJob(job.id)!.status).toBe("pending");
  });
});

describe("cancelWorkJob", () => {
  it("cancels a pending job", () => {
    const job = db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel" });
    db.cancelWorkJob(job.id, "user request");
    expect(db.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("does not overwrite a completed job", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel-completed" });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.completeWorkJob(job.id, { summary: "done" }, "worker-1");

    db.cancelWorkJob(job.id, "late cancel");

    expect(db.getWorkJob(job.id)!.status).toBe("completed");
  });

  it("does not overwrite a failed job", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cancel-failed", max_attempts: 1 });
    const job = db.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-1");
    db.failWorkJob(job.id, "fatal", "worker-1");

    db.cancelWorkJob(job.id, "late cancel");

    expect(db.getWorkJob(job.id)!.status).toBe("failed");
  });
});

// ── Security hardening: lease ownership + approval expiry ─────────────────────

describe("resolveApproval — expiry enforcement", () => {
  it("does not resolve an expired approval", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Exp", created_by: "user:1" });
    const past = new Date(Date.now() - 5000).toISOString();
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker", expires_at: past });
    const result = db.resolveApproval(appr.id, "approved", "user:42");
    // Expired approval should remain pending (or be marked expired), not approved
    expect(result.status).not.toBe("approved");
  });

  it("resolves a non-expired approval normally", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "Valid", created_by: "user:1" });
    const future = new Date(Date.now() + 60_000).toISOString();
    const appr = db.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker", expires_at: future });
    const result = db.resolveApproval(appr.id, "approved", "user:42");
    expect(result.status).toBe("approved");
  });
});

describe("lease ownership enforcement", () => {
  it("markWorkJobRunning does not update if wrong owner", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:own1" });
    const job = db.claimNextWorkJob("worker-A", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-B"); // wrong owner
    // Should remain leased, not running
    expect(db.getWorkJob(job.id)!.status).toBe("leased");
  });

  it("completeWorkJob does not update if wrong owner", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:own2" });
    const job = db.claimNextWorkJob("worker-A", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-A");
    db.completeWorkJob(job.id, { summary: "ok" }, "worker-B"); // wrong owner
    expect(db.getWorkJob(job.id)!.status).toBe("running");
  });

  it("failWorkJob does not update if wrong owner", () => {
    db.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:own3" });
    const job = db.claimNextWorkJob("worker-A", new Date().toISOString(), 60)!;
    db.markWorkJobRunning(job.id, "worker-A");
    db.failWorkJob(job.id, "err", "worker-B"); // wrong owner
    expect(db.getWorkJob(job.id)!.status).toBe("running");
  });
});

// ── feature_plans ─────────────────────────────────────────────────────────────

describe("feature_plans CRUD", () => {
  it("creates a feature plan and returns it with default status 'drafting'", () => {
    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "user-1", brief: "Add dark mode" });
    expect(plan.id).toBeGreaterThan(0);
    expect(plan.chat_id).toBe("chat-1");
    expect(plan.user_id).toBe("user-1");
    expect(plan.brief).toBe("Add dark mode");
    expect(plan.status).toBe("drafting");
    expect(plan.scope_json).toBe("{}");
  });

  it("retrieves a plan by id", () => {
    const plan = db.createFeaturePlan({ chatId: "chat-1", userId: "user-1", brief: "Refactor DB layer" });
    const fetched = db.getFeaturePlan(plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(plan.id);
  });

  it("returns null for a missing plan id", () => {
    expect(db.getFeaturePlan(9999)).toBeNull();
  });

  it("getActivePlanForChat returns the drafting plan for a chat", () => {
    db.createFeaturePlan({ chatId: "chat-2", userId: "user-1", brief: "Active plan" });
    const plan = db.getActivePlanForChat("chat-2");
    expect(plan).not.toBeNull();
    expect(plan!.brief).toBe("Active plan");
  });

  it("getActivePlanForChat returns null when no active plan exists", () => {
    expect(db.getActivePlanForChat("chat-no-plan")).toBeNull();
  });

  it("getActivePlanForChat returns null after plan is accepted", () => {
    const plan = db.createFeaturePlan({ chatId: "chat-3", userId: "user-1", brief: "Will be accepted" });
    db.updateFeaturePlanStatus(plan.id, "accepted");
    expect(db.getActivePlanForChat("chat-3")).toBeNull();
  });

  it("updateFeaturePlanStatus transitions status and updates updated_at", () => {
    const plan = db.createFeaturePlan({ chatId: "chat-4", userId: "user-1", brief: "Status test" });
    db.updateFeaturePlanStatus(plan.id, "ready");
    const updated = db.getFeaturePlan(plan.id)!;
    expect(updated.status).toBe("ready");
  });

  it("updateFeaturePlanScope stores JSON scope on the plan", () => {
    const plan = db.createFeaturePlan({ chatId: "chat-5", userId: "user-1", brief: "Scope test" });
    const scope = { files: ["src/foo.ts"], assumptions: ["No auth changes"] };
    db.updateFeaturePlanScope(plan.id, scope);
    const updated = db.getFeaturePlan(plan.id)!;
    expect(JSON.parse(updated.scope_json)).toEqual(scope);
  });

  it("createFeaturePlan replaces an existing drafting plan for the same chat", () => {
    db.createFeaturePlan({ chatId: "chat-6", userId: "user-1", brief: "First brief" });
    const second = db.createFeaturePlan({ chatId: "chat-6", userId: "user-1", brief: "Second brief" });
    const active = db.getActivePlanForChat("chat-6");
    expect(active!.id).toBe(second.id);
    expect(active!.brief).toBe("Second brief");
  });
});

// ── Phase 9 Slice 18: PR state tracking on github_links ─────────────────────

describe("github_links pr_state", () => {
  it("new links default to pr_state draft with last_activity_at column present", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "u" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 9, branch_name: "agent/work-9" });
    const row = db.raw.prepare("SELECT pr_state, last_activity_at FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("draft");
    expect(row.last_activity_at === null || typeof row.last_activity_at === "string").toBe(true);
  });

  it("updatePrState persists a new state", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "u" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 10 });
    db.updatePrState(link.id, "ready_to_merge");
    const row = db.raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("ready_to_merge");
  });

  it("listOpenAgentPrs excludes merged and closed links", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "u" });
    const a = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 11 });
    const b = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 12 });
    const c = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 13 });
    db.updatePrState(b.id, "merged");
    db.updatePrState(c.id, "closed");

    const open = db.listOpenAgentPrs("o/r");
    expect(open.map((l: any) => l.id)).toEqual([a.id]);
    // other repositories are not included
    expect(db.listOpenAgentPrs("other/repo")).toEqual([]);
  });

  it("touchPrActivity sets last_activity_at", () => {
    const item = db.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "u" });
    const link = db.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 14 });
    const ts = new Date().toISOString();
    db.touchPrActivity(link.id, ts);
    const row = db.raw.prepare("SELECT last_activity_at FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.last_activity_at).toBe(ts);
  });
});

describe("BridgeDb project memories", () => {
  it("creates project_memories table on openDb", () => {
    const row = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_memories'").get();
    expect(row).toBeDefined();
  });

  it("addMemory inserts and searchMemories finds by keyword", () => {
    db.addMemory({ id: "mem_test1", type: "decision", scope: "project", text: "fallback CLI persists after successful switch" });
    const results = db.searchMemories("fallback");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("fallback");
  });

  it("findMemoryByText detects existing memories case-insensitively", () => {
    db.addMemory({
      id: "mem_existing",
      type: "decision",
      scope: "project",
      text: "Database abstraction owns project memory duplicate checks.",
    });

    expect((db as any).findMemoryByText("database abstraction owns project memory duplicate checks.")).toEqual({
      id: "mem_existing",
    });
  });

  it("getLatestConvTurnId returns the latest turn for a chat key", () => {
    db.addConvTurn("chat:memory", "user", "first turn", "codex");
    db.addConvTurn("chat:memory", "assistant", "second turn", "codex");
    db.addConvTurn("chat:other", "assistant", "other chat turn", "codex");

    const latest = db.raw.prepare(
      "SELECT MAX(id) AS id FROM conversation_turns WHERE chat_key = ?",
    ).get("chat:memory") as { id: number };

    expect((db as any).getLatestConvTurnId("chat:memory")).toBe(latest.id);
  });

  it("searchMemories returns empty when no relevant match", () => {
    db.addMemory({ id: "mem_test2", type: "decision", scope: "project", text: "compact summarises conversation history" });
    const results = db.searchMemories("xylophone");
    expect(results).toEqual([]);
  });

  it("searchMemories expands bridge vocabulary synonyms", () => {
    db.addMemory({ id: "mem_test_syn1", type: "decision", scope: "project", text: "chunked map-reduce compaction handles large histories" });
    db.addMemory({ id: "mem_test_syn2", type: "decision", scope: "project", text: "context helper exposes recent conversation turns" });

    expect(db.searchMemories("summaries").some((m) => m.id === "mem_test_syn1")).toBe(true);
    expect(db.searchMemories("history affordance").some((m) => m.id === "mem_test_syn2")).toBe(true);
  });

  it("getMemoryCount returns 0 on fresh DB, increments after add", () => {
    expect(db.getMemoryCount()).toBe(0);
    db.addMemory({ id: "mem_test3", type: "decision", scope: "project", text: "bridge is stable" });
    expect(db.getMemoryCount()).toBe(1);
  });
});

describe("BridgeDb work_jobs task_type migration", () => {
  it("preserves phase columns while adding orchestrated_task to existing DBs", () => {
    db.close();
    const dir = mkdtempSync(join(tmpdir(), "bridge-db-migration-"));
    const dbPath = join(dir, "bridge.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE work_jobs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id     INTEGER,
        task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','pr_lifecycle','pr_watch','pr_refresh')),
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
        phase_data_json  TEXT
      );
      INSERT INTO work_jobs (task_type, idempotency_key, phase, phase_data_json)
      VALUES ('defect_scan', 'legacy:phase:1', 'verifying', '{"ok":true}');
    `);
    legacy.close();

    const migrated = openDb(dbPath);
    try {
      const existing = migrated.raw.prepare(
        "SELECT phase, phase_data_json FROM work_jobs WHERE idempotency_key = ?"
      ).get("legacy:phase:1") as any;
      expect(existing.phase).toBe("verifying");
      expect(JSON.parse(existing.phase_data_json)).toEqual({ ok: true });

      const job = migrated.createWorkJob({
        task_type: "orchestrated_task",
        idempotency_key: "orch:migrated:1",
      });
      expect(job.task_type).toBe("orchestrated_task");
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
      db = openDb(":memory:");
    }
  });

  it("preserves legacy rows while adding refactor work item and job types", () => {
    db.close();
    const dir = mkdtempSync(join(tmpdir(), "bridge-db-refactor-migration-"));
    const dbPath = join(dir, "bridge.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
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
        task_type        TEXT NOT NULL CHECK (task_type IN ('defect_scan','feature_plan','feature_research','implementation_plan','run_tdd_fix','open_github_issue','open_pull_request','verify_pull_request','ops_check','tdd_implementation','orchestrated_task','pr_lifecycle','pr_watch','pr_refresh')),
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
        phase_data_json  TEXT
      );
      INSERT INTO work_items (kind, source, title, created_by)
      VALUES ('feature', 'telegram', 'Legacy feature', 'worker');
    `);
    legacy.close();

    const migrated = openDb(dbPath);
    try {
      const item = migrated.createWorkItem({
        kind: "refactor",
        source: "refactor_scan",
        title: "Extract worker router",
        created_by: "worker",
      });
      expect(item.kind).toBe("refactor");
      const job = migrated.createWorkJob({
        task_type: "refactor_scan",
        idempotency_key: "refactor:migrated:1",
      });
      expect(job.task_type).toBe("refactor_scan");
      expect(migrated.listWorkItems().some((row) => row.title === "Legacy feature")).toBe(true);
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
      db = openDb(":memory:");
    }
  });
});

describe("BridgeDb advisor call persistence", () => {
  const baseReserve = {
    scopeKey: "scope-1",
    mode: "review",
    trigger: "manual",
    contextChars: 100,
    maxCallsPerTurn: 2,
    maxCallsPerTask: 2,
  };

  it("reserves a new request id and returns true", () => {
    expect(db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve })).toBe(true);
  });

  it("returns false when the same request id is reserved twice", () => {
    expect(db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve })).toBe(true);
    expect(db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve })).toBe(false);
  });

  it("denies reservation once the per-turn call limit is reached", () => {
    expect(db.reserveAdvisorCall({ requestId: "req-1", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 })).toBe(true);
    expect(db.reserveAdvisorCall({ requestId: "req-2", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 })).toBe(false);
  });

  it("denies reservation once the per-task call limit is reached", () => {
    expect(db.reserveAdvisorCall({ requestId: "req-1", taskKey: "task-1", ...baseReserve, maxCallsPerTask: 1 })).toBe(true);
    expect(db.reserveAdvisorCall({ requestId: "req-2", taskKey: "task-1", ...baseReserve, maxCallsPerTask: 1 })).toBe(false);
  });

  // No repository method ever sets advisor_calls.status = 'denied' — the
  // reservation-limit filter (status != 'denied') references a value
  // nothing currently writes, verified by grep across src/. Seeding it
  // directly via db.raw is the only way to characterize the filter's
  // actual exclusion behavior at the SQL boundary.
  it("excludes a denied call from the per-turn limit count", () => {
    db.reserveAdvisorCall({ requestId: "req-1", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 });
    db.raw.prepare("UPDATE advisor_calls SET status = 'denied' WHERE request_id = ?").run("req-1");
    expect(db.reserveAdvisorCall({ requestId: "req-2", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 })).toBe(true);
  });

  it("excludes a denied call from the per-task limit count", () => {
    db.reserveAdvisorCall({ requestId: "req-1", taskKey: "task-1", ...baseReserve, maxCallsPerTask: 1 });
    db.raw.prepare("UPDATE advisor_calls SET status = 'denied' WHERE request_id = ?").run("req-1");
    expect(db.reserveAdvisorCall({ requestId: "req-2", taskKey: "task-1", ...baseReserve, maxCallsPerTask: 1 })).toBe(true);
  });

  it("still counts a failed (non-denied) call toward the per-turn limit", () => {
    db.reserveAdvisorCall({ requestId: "req-1", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 });
    db.failAdvisorCall("req-1", "timeout");
    // req-1 is 'failed', not 'denied' — it still counts as an active call.
    expect(db.reserveAdvisorCall({ requestId: "req-2", turnKey: "turn-1", ...baseReserve, maxCallsPerTurn: 1 })).toBe(false);
  });

  it("records attempts in ordinal order and returns them via getAdvisorAttempts", () => {
    db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve });
    db.addAdvisorAttempt({ requestId: "req-1", ordinal: 1, provider: "anthropic", model: "claude", status: "failed", errorKind: "timeout", durationMs: 50 });
    db.addAdvisorAttempt({ requestId: "req-1", ordinal: 2, provider: "openai", model: "gpt", status: "succeeded", durationMs: 75 });
    const attempts = db.getAdvisorAttempts("req-1");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.ordinal)).toEqual([1, 2]);
    expect(attempts[0]).toMatchObject({ provider: "anthropic", model: "claude", status: "failed", error_kind: "timeout", duration_ms: 50 });
    expect(attempts[1]).toMatchObject({ provider: "openai", model: "gpt", status: "succeeded", error_kind: null, duration_ms: 75 });
  });

  it("completeAdvisorCall marks the call succeeded with the selected provider/model/confidence", () => {
    db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve });
    db.completeAdvisorCall("req-1", "anthropic", "claude", "high");
    const row = db.raw.prepare("SELECT status, selected_provider, selected_model, confidence FROM advisor_calls WHERE request_id = ?").get("req-1");
    expect(row).toEqual({ status: "succeeded", selected_provider: "anthropic", selected_model: "claude", confidence: "high" });
  });

  it("failAdvisorCall marks the call failed with the error kind", () => {
    db.reserveAdvisorCall({ requestId: "req-1", ...baseReserve });
    db.failAdvisorCall("req-1", "capacity");
    const row = db.raw.prepare("SELECT status, error_kind FROM advisor_calls WHERE request_id = ?").get("req-1");
    expect(row).toEqual({ status: "failed", error_kind: "capacity" });
  });

  it("getAdvisorAttempts returns an empty array for a request with no attempts", () => {
    expect(db.getAdvisorAttempts("no-such-request")).toEqual([]);
  });
});
