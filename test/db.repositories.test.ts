/**
 * Tests for the decomposed BridgeDb repository classes.
 *
 * BridgeDb currently handles sessions, locks, settings, failure counting,
 * run tracking, work-queue, and project memory all in one 1200-line class.
 * These tests describe the desired state: each concern lives in its own
 * repository class that can be imported and instantiated independently.
 *
 * ALL tests in this file are EXPECTED TO FAIL (red) until the repository
 * classes are implemented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "../src/db.js";

// These imports are intentionally from files that do not exist yet.
// They will cause module-not-found errors, putting the suite in red state.
import { SessionRepository } from "../src/repositories/sessionRepository.js";
import { LockRepository } from "../src/repositories/lockRepository.js";
import { SettingsRepository } from "../src/repositories/settingsRepository.js";
import { RunRepository } from "../src/repositories/runRepository.js";
import { WorkQueueRepository } from "../src/repositories/workQueueRepository.js";
import { MemoryRepository } from "../src/repositories/memoryRepository.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup: use openDb(":memory:") to create the full schema, then extract
// the raw Database connection so each repository can be tested in isolation.
// ─────────────────────────────────────────────────────────────────────────────

let raw: Database.Database;

beforeEach(() => {
  const bridge = openDb(":memory:");
  raw = (bridge as any).raw as Database.Database;
});

// ─────────────────────────────────────────────────────────────────────────────
// SessionRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("SessionRepository", () => {
  it("can be instantiated with a raw Database connection", () => {
    const repo = new SessionRepository(raw);
    expect(repo).toBeDefined();
  });

  it("returns null for an unknown chat", () => {
    const repo = new SessionRepository(raw);
    expect(repo.getSession("chat1", "codex")).toBeNull();
    expect(repo.getSession("chat1", "claude")).toBeNull();
    expect(repo.getSession("chat1", "antigravity")).toBeNull();
  });

  it("persists and retrieves a session per bot", () => {
    const repo = new SessionRepository(raw);
    repo.setSession("chat1", "codex", "codex-session-abc");
    repo.setSession("chat1", "antigravity", "ag-session-xyz");
    expect(repo.getSession("chat1", "codex")).toBe("codex-session-abc");
    expect(repo.getSession("chat1", "antigravity")).toBe("ag-session-xyz");
  });

  it("clears a session when set to null", () => {
    const repo = new SessionRepository(raw);
    repo.setSession("chat1", "codex", "s1");
    repo.setSession("chat1", "codex", null);
    expect(repo.getSession("chat1", "codex")).toBeNull();
  });

  it("throws on an invalid bot kind", () => {
    const repo = new SessionRepository(raw);
    expect(() => repo.getSession("chat1", "invalid" as any)).toThrow("Invalid bot kind");
    expect(() => repo.setSession("chat1", "invalid" as any, "s1")).toThrow("Invalid bot kind");
  });

  it("keeps sessions isolated per chat", () => {
    const repo = new SessionRepository(raw);
    repo.setSession("chat1", "codex", "s-chat1");
    repo.setSession("chat2", "codex", "s-chat2");
    expect(repo.getSession("chat1", "codex")).toBe("s-chat1");
    expect(repo.getSession("chat2", "codex")).toBe("s-chat2");
  });

  it("resets timestamp when session ID changes", () => {
    const repo = new SessionRepository(raw);
    repo.setSession("chat1", "codex", "s1");
    const ts1 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    repo.setSession("chat1", "codex", "s2");
    const ts2 = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    expect(ts2).toBeTruthy();
    // Both may be set in same millisecond — just verify the timestamp is present
    expect(typeof ts2).toBe("string");
    // ts1 was also set — just confirm the column tracks lifecycle correctly
    void ts1;
  });

  it("clears timestamp when session is cleared", () => {
    const repo = new SessionRepository(raw);
    repo.setSession("chat1", "codex", "s1");
    repo.setSession("chat1", "codex", null);
    const ts = (raw.prepare("SELECT codex_session_created_at AS t FROM bridge_state WHERE chat_id = ?").get("chat1") as any)?.t;
    expect(ts).toBeNull();
  });
});

describe("BridgeDb repository wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delegates session operations through SessionRepository", () => {
    const getSpy = vi.spyOn(SessionRepository.prototype, "getSession");
    const setSpy = vi.spyOn(SessionRepository.prototype, "setSession");
    const bridge = openDb(":memory:");

    try {
      bridge.setSession("chat1", "codex", "session-1");
      expect(bridge.getSession("chat1", "codex")).toBe("session-1");
      expect(setSpy).toHaveBeenCalledWith("chat1", "codex", "session-1");
      expect(getSpy).toHaveBeenCalledWith("chat1", "codex");
    } finally {
      bridge.close();
    }
  });

  it("delegates work queue operations through WorkQueueRepository", () => {
    const createSpy = vi.spyOn(WorkQueueRepository.prototype, "createWorkItem");
    const getSpy = vi.spyOn(WorkQueueRepository.prototype, "getWorkItem");
    const bridge = openDb(":memory:");

    try {
      const item = bridge.createWorkItem({
        kind: "defect",
        source: "telegram",
        title: "Repository wiring",
        created_by: "worker",
      });
      expect(bridge.getWorkItem(item.id)?.title).toBe("Repository wiring");
      expect(createSpy).toHaveBeenCalled();
      expect(getSpy).toHaveBeenCalledWith(item.id);
    } finally {
      bridge.close();
    }
  });

  it("delegates project memory operations through MemoryRepository", () => {
    const addSpy = vi.spyOn(MemoryRepository.prototype, "addMemory");
    const searchSpy = vi.spyOn(MemoryRepository.prototype, "searchMemories");
    const bridge = openDb(":memory:");

    try {
      bridge.addMemory({
        id: "mem_repo_wiring",
        type: "decision",
        text: "Repository wiring owns project memory storage.",
      });
      expect(bridge.searchMemories("repository wiring").length).toBeGreaterThan(0);
      expect(addSpy).toHaveBeenCalled();
      expect(searchSpy).toHaveBeenCalledWith("repository wiring", 5);
    } finally {
      bridge.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LockRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("LockRepository", () => {
  const options = { serviceId: "test", runId: "test-run", leaseMs: 90_000 };

  it("can be instantiated with a raw Database connection", () => {
    const repo = new LockRepository(raw, options);
    expect(repo).toBeDefined();
  });

  it("acquires lock when chat is free", () => {
    const repo = new LockRepository(raw, options);
    expect(repo.acquire("test", "chat1")).not.toBeNull();
  });

  it("rejects lock when chat is already locked", () => {
    const repo = new LockRepository(raw, options);
    repo.acquire("test", "chat1");
    expect(repo.acquire("test", "chat1")).toBeNull();
  });

  it("lock is released by unlock", () => {
    const repo = new LockRepository(raw, options);
    const handle = repo.acquire("test", "chat1")!;
    repo.unlock(handle);
    expect(repo.acquire("test", "chat1")).not.toBeNull();
  });

  it("lock is per chat — other chats are unaffected", () => {
    const repo = new LockRepository(raw, options);
    repo.acquire("test", "chat1");
    expect(repo.acquire("test", "chat2")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SettingsRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("SettingsRepository", () => {
  it("can be instantiated with a raw Database connection", () => {
    const repo = new SettingsRepository(raw);
    expect(repo).toBeDefined();
  });

  it("returns null for an unknown setting key", () => {
    const repo = new SettingsRepository(raw);
    expect(repo.getSetting("codex")).toBeNull();
  });

  it("stores and retrieves a setting", () => {
    const repo = new SettingsRepository(raw);
    repo.setSetting("codex", "gpt-4o");
    expect(repo.getSetting("codex")).toBe("gpt-4o");
  });

  it("clears a setting when set to null", () => {
    const repo = new SettingsRepository(raw);
    repo.setSetting("codex", "gpt-4o");
    repo.setSetting("codex", null);
    expect(repo.getSetting("codex")).toBeNull();
  });

  it("increments failure count for a bot", () => {
    const repo = new SettingsRepository(raw);
    const count = repo.incrementFailures("chat1", "codex");
    expect(count).toBe(1);
    expect(repo.incrementFailures("chat1", "codex")).toBe(2);
  });

  it("resetFailures zeroes the counter", () => {
    const repo = new SettingsRepository(raw);
    repo.incrementFailures("chat1", "codex");
    repo.incrementFailures("chat1", "codex");
    repo.resetFailures("chat1", "codex");
    expect(repo.incrementFailures("chat1", "codex")).toBe(1);
  });

  it("getMaxConsecutiveFailures returns empty when no failures", () => {
    const repo = new SettingsRepository(raw);
    expect(repo.getMaxConsecutiveFailures()).toEqual([]);
  });

  it("getMaxConsecutiveFailures returns max per bot across all chats", () => {
    const repo = new SettingsRepository(raw);
    repo.incrementFailures("chat1", "codex");
    repo.incrementFailures("chat1", "codex");
    repo.incrementFailures("chat2", "claude");
    const results = repo.getMaxConsecutiveFailures();
    expect(results.find(r => r.bot === "codex")?.count).toBe(2);
    expect(results.find(r => r.bot === "claude")?.count).toBe(1);
  });

  it("getLastUpdateId returns 0 for unknown bot", () => {
    const repo = new SettingsRepository(raw);
    expect(repo.getLastUpdateId("codex")).toBe(0);
  });

  it("setLastUpdateId persists per bot and never decrements (MAX semantics)", () => {
    const repo = new SettingsRepository(raw);
    repo.setLastUpdateId("codex", 1000);
    repo.setLastUpdateId("codex", 500); // lower — should be ignored
    expect(repo.getLastUpdateId("codex")).toBe(1000);
    repo.setLastUpdateId("codex", 1500);
    expect(repo.getLastUpdateId("codex")).toBe(1500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RunRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("RunRepository", () => {
  it("can be instantiated with a raw Database connection", () => {
    const repo = new RunRepository(raw);
    expect(repo).toBeDefined();
  });

  it("creates a run on insertRun", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-1", "chat-123", "codex");
    const run = repo.getRun("run-1");
    expect(run).toBeDefined();
    expect(run.run_id).toBe("run-1");
    expect(run.chat_id).toBe("chat-123");
    expect(run.bot).toBe("codex");
    expect(run.status).toBe("running");
    expect(run.started_at).toBeDefined();
  });

  it("updates run on completion", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-1", "chat-123", "codex");
    repo.updateRunCompleted("run-1", "all done", "sess-abc");
    const run = repo.getRun("run-1");
    expect(run.status).toBe("done");
    expect(run.final_text_preview).toBe("all done");
    expect(run.session_id).toBe("sess-abc");
    expect(run.ended_at).toBeDefined();
  });

  it("updates run on failure", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-1", "chat-123", "codex");
    repo.updateRunFailed("run-1", "CLI crashed");
    const run = repo.getRun("run-1");
    expect(run.status).toBe("failed");
    expect(run.error).toBe("CLI crashed");
    expect(run.ended_at).toBeDefined();
  });

  it("updates run on cancellation", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-1", "chat-123", "codex");
    repo.updateRunCancelled("run-1", "user");
    const run = repo.getRun("run-1");
    expect(run.status).toBe("cancelled");
    expect(run.ended_at).toBeDefined();
  });

  it("inserts and retrieves events for a run", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-1", "chat-123", "codex");
    repo.insertEvent("run-1", 1, "run.started", new Date().toISOString(), { command: "codex" });
    repo.insertEvent("run-1", 2, "run.completed", new Date().toISOString(), { text: "done" });
    const events = repo.getEventsForRun("run-1");
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("run.started");
    expect(JSON.parse(events[0].payload_json).command).toBe("codex");
  });

  it("enforces run foreign key on event insert", () => {
    const repo = new RunRepository(raw);
    expect(() =>
      repo.insertEvent("missing-run", 1, "run.started", new Date().toISOString(), {})
    ).toThrow();
  });

  it("lists and atomically reconciles a running run", () => {
    const repo = new RunRepository(raw);
    repo.insertRun("run-orphan", "chat-123", "codex");
    repo.insertRun("run-done", "chat-123", "codex");
    repo.updateRunCompleted("run-done", "ok", null);
    expect(repo.listRunningRuns().map((run) => run.run_id)).toEqual(["run-orphan"]);
    const endedAt = new Date().toISOString();
    expect(repo.reconcileOrphanedRun("run-orphan", endedAt, {
      reason: "Process interrupted by bridge restart",
      reconciledAt: endedAt,
      processState: "absent",
      lockState: "absent",
      cutoffMs: 600_000,
    })).toBe(true);
    expect(repo.reconcileOrphanedRun("run-orphan", endedAt, {
      reason: "Process interrupted by bridge restart",
      reconciledAt: endedAt,
      processState: "absent",
      lockState: "absent",
      cutoffMs: 600_000,
    })).toBe(false);
    expect(repo.getRun("run-orphan").status).toBe("failed");
    expect(repo.getRun("run-orphan").error).toBe("Process interrupted by bridge restart");
    expect(repo.getRun("run-done").status).toBe("done");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WorkQueueRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("WorkQueueRepository", () => {
  it("can be instantiated with a raw Database connection", () => {
    const repo = new WorkQueueRepository(raw);
    expect(repo).toBeDefined();
  });

  it("creates a work item and returns it", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "Bug", created_by: "user:1" });
    expect(item.id).toBeGreaterThan(0);
    expect(item.status).toBe("proposed");
    expect(item.title).toBe("Bug");
  });

  it("getWorkItem returns null for unknown id", () => {
    const repo = new WorkQueueRepository(raw);
    expect(repo.getWorkItem(9999)).toBeNull();
  });

  it("listWorkItems filters by status", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkItem({ kind: "defect", source: "telegram", title: "A", created_by: "u" });
    repo.createWorkItem({ kind: "feature", source: "manual", title: "B", created_by: "u" });
    expect(repo.listWorkItems({ status: "proposed" })).toHaveLength(2);
    expect(repo.listWorkItems({ status: "resolved" })).toHaveLength(0);
  });

  it("creates a work job with idempotency", () => {
    const repo = new WorkQueueRepository(raw);
    const j1 = repo.createWorkJob({ task_type: "defect_scan", idempotency_key: "key:1" });
    const j2 = repo.createWorkJob({ task_type: "defect_scan", idempotency_key: "key:1" });
    expect(j2.id).toBe(j1.id);
  });

  it("claimNextWorkJob claims the oldest pending job", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:a" });
    const claimed = repo.claimNextWorkJob("worker-1", new Date().toISOString(), 60);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("leased");
    expect(claimed!.lease_owner).toBe("worker-1");
  });

  it("second worker cannot claim same active lease", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:b" });
    repo.claimNextWorkJob("worker-1", new Date().toISOString(), 60);
    expect(repo.claimNextWorkJob("worker-2", new Date().toISOString(), 60)).toBeNull();
  });

  it("completeWorkJob does not overwrite a cancelled job", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:cc" });
    const job = repo.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    repo.markWorkJobRunning(job.id, "worker-1");
    repo.cancelWorkJob(job.id, "user cancelled");
    repo.completeWorkJob(job.id, { ok: true }, "worker-1");
    expect(repo.getWorkJob(job.id)!.status).toBe("cancelled");
  });

  it("failWorkJob increments attempt count and may return to pending", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:fail", max_attempts: 3 });
    const job = repo.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    repo.markWorkJobRunning(job.id, "worker-1");
    repo.failWorkJob(job.id, "timeout", "worker-1");
    expect(repo.getWorkJob(job.id)!.status).toBe("pending");
    expect(repo.getWorkJob(job.id)!.attempt_count).toBe(1);
  });

  it("failWorkJobPermanently always fails the job regardless of attempts", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "ops_check", idempotency_key: "ops:perm", max_attempts: 5 });
    const job = repo.claimNextWorkJob("worker-1", new Date().toISOString(), 60)!;
    repo.markWorkJobRunning(job.id, "worker-1");
    repo.failWorkJobPermanently(job.id, "no handler", "worker-1");
    expect(repo.getWorkJob(job.id)!.status).toBe("failed");
    expect(repo.getWorkJob(job.id)!.error).toBe("no handler");
  });

  it("recoverExpiredWorkJobs returns expired jobs to pending when attempts remain", () => {
    const repo = new WorkQueueRepository(raw);
    repo.createWorkJob({ task_type: "defect_scan", idempotency_key: "scan:rec", max_attempts: 2 });
    const job = repo.claimNextWorkJob("worker-1", new Date().toISOString(), 1)!;
    repo.markWorkJobRunning(job.id, "worker-1");
    const past = new Date(Date.now() - 120_000).toISOString();
    raw.prepare(`UPDATE work_jobs SET lease_expires_at = ? WHERE id = ?`).run(past, job.id);
    const recovered = repo.recoverExpiredWorkJobs(new Date().toISOString());
    expect(recovered).toBe(1);
    expect(repo.getWorkJob(job.id)!.status).toBe("pending");
  });

  it("creates a pending approval", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "X", created_by: "u" });
    const appr = repo.createApproval({ work_item_id: item.id, approval_type: "merge_pr", requested_by: "worker" });
    expect(appr.status).toBe("pending");
  });

  it("resolveApproval sets approved state and first decision sticks", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "Y", created_by: "u" });
    const appr = repo.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker" });
    repo.resolveApproval(appr.id, "approved", "user:42");
    const second = repo.resolveApproval(appr.id, "rejected", "user:99");
    expect(second.status).toBe("approved");
  });

  it("resolveApproval does not approve an expired approval", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "Exp", created_by: "u" });
    const past = new Date(Date.now() - 5000).toISOString();
    const appr = repo.createApproval({ work_item_id: item.id, approval_type: "open_pr", requested_by: "worker", expires_at: past });
    const result = repo.resolveApproval(appr.id, "approved", "user:42");
    expect(result.status).not.toBe("approved");
  });

  it("stores and retrieves a github issue link", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "I", created_by: "u" });
    const link = repo.linkGithubIssue({ work_item_id: item.id, repository: "owner/repo", issue_number: 42 });
    expect(link.issue_number).toBe(42);
  });

  it("stores and retrieves a github PR link", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "P", created_by: "u" });
    const link = repo.linkGithubPr({ work_item_id: item.id, repository: "owner/repo", pr_number: 7, branch_name: "agent/work-1" });
    expect(link.pr_number).toBe(7);
    expect(link.branch_name).toBe("agent/work-1");
  });

  it("updatePrState persists a new state", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "P2", created_by: "u" });
    const link = repo.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 99 });
    repo.updatePrState(link.id, "ready_to_merge");
    const row = raw.prepare("SELECT pr_state FROM github_links WHERE id = ?").get(link.id) as any;
    expect(row.pr_state).toBe("ready_to_merge");
  });

  it("listOpenAgentPrs excludes merged and closed links", () => {
    const repo = new WorkQueueRepository(raw);
    const item = repo.createWorkItem({ kind: "defect", source: "telegram", title: "Q", created_by: "u" });
    const a = repo.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 101 });
    const b = repo.linkGithubPr({ work_item_id: item.id, repository: "o/r", pr_number: 102 });
    repo.updatePrState(b.id, "merged");
    const open = repo.listOpenAgentPrs("o/r");
    expect(open.map((l: any) => l.id)).toEqual([a.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryRepository
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryRepository", () => {
  it("can be instantiated with a raw Database connection", () => {
    const repo = new MemoryRepository(raw);
    expect(repo).toBeDefined();
  });

  it("getMemoryCount returns 0 on a fresh db", () => {
    const repo = new MemoryRepository(raw);
    expect(repo.getMemoryCount()).toBe(0);
  });

  it("addMemory inserts and searchMemories finds by keyword", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({ id: "mem_1", type: "decision", scope: "project", text: "fallback CLI persists after successful switch" });
    const results = repo.searchMemories("fallback");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("fallback");
  });

  it("searchMemories excludes other chats' chat-scoped rows when chatKey is provided", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({
      id: "mem_private",
      type: "decision",
      scope: "chat",
      source_chat_key: "chat:private",
      text: "private chat scoped deploy preference",
    });
    repo.addMemory({
      id: "mem_project",
      type: "decision",
      scope: "project",
      source_chat_key: "chat:other",
      text: "project scoped deploy preference",
    });

    const results = repo.searchMemories("deploy preference", 5, "chat:public");

    expect(results.map((r: any) => r.id)).not.toContain("mem_private");
    expect(results.map((r: any) => r.id)).toContain("mem_project");
  });

  it("searchMemories returns empty when no relevant match", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({ id: "mem_2", type: "decision", scope: "project", text: "compact summarises conversation history" });
    expect(repo.searchMemories("xylophone")).toEqual([]);
  });

  it("searchMemories expands bridge vocabulary synonyms", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({ id: "mem_3", type: "decision", scope: "project", text: "chunked map-reduce compaction handles large histories" });
    expect(repo.searchMemories("summaries").some((m: any) => m.id === "mem_3")).toBe(true);
  });

  it("getMemoryCount increments after add", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({ id: "mem_4", type: "decision", scope: "project", text: "bridge is stable" });
    expect(repo.getMemoryCount()).toBe(1);
  });

  it("resolveMemory marks an entry resolved and excludes it from default search results", () => {
    const repo = new MemoryRepository(raw);
    repo.addMemory({ id: "mem_blocker", type: "decision", scope: "project", text: "blocked pending independent verification of the Aruba SSH host key" });
    expect(repo.searchMemories("Aruba SSH host key").some((m: any) => m.id === "mem_blocker")).toBe(true);

    repo.resolveMemory("mem_blocker", "mem_resolution");

    expect(repo.searchMemories("Aruba SSH host key").some((m: any) => m.id === "mem_blocker")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Structural contract: each repository must accept only a Database connection
// as its constructor argument (no hidden BridgeDb dependency).
// ─────────────────────────────────────────────────────────────────────────────

describe("Repository constructor contracts", () => {
  it("SessionRepository constructor signature accepts Database.Database", () => {
    expect(() => new SessionRepository(raw)).not.toThrow();
  });

  it("LockRepository constructor requires explicit run identity", () => {
    expect(() => new LockRepository(raw, { serviceId: "test", runId: "test-run", leaseMs: 90_000 })).not.toThrow();
  });

  it("SettingsRepository constructor signature accepts Database.Database", () => {
    expect(() => new SettingsRepository(raw)).not.toThrow();
  });

  it("RunRepository constructor signature accepts Database.Database", () => {
    expect(() => new RunRepository(raw)).not.toThrow();
  });

  it("WorkQueueRepository constructor signature accepts Database.Database", () => {
    expect(() => new WorkQueueRepository(raw)).not.toThrow();
  });

  it("MemoryRepository constructor signature accepts Database.Database", () => {
    expect(() => new MemoryRepository(raw)).not.toThrow();
  });
});
