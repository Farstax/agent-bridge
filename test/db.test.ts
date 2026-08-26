import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_RECENT_TURN_LIMIT } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

describe("BridgeDb ordinary Run state", () => {
  it("keeps sessions isolated by chat and provider", () => {
    db.setSession("chat-1", "codex", "codex-1");
    db.setSession("chat-1", "claude", "claude-1");
    db.setSession("chat-2", "codex", "codex-2");
    expect(db.getSession("chat-1", "codex")).toBe("codex-1");
    expect(db.getSession("chat-1", "claude")).toBe("claude-1");
    expect(db.getSession("chat-2", "codex")).toBe("codex-2");
  });

  it("fences one execution lane per surface and chat", () => {
    const first = db.acquireLock("telegram:interactive", "chat-1");
    expect(first).not.toBeNull();
    expect(db.acquireLock("telegram:interactive", "chat-1")).toBeNull();
    expect(db.acquireLock("telegram:interactive", "chat-2")).not.toBeNull();
    expect(db.acquireLock("telegram:codex", "chat-1")).not.toBeNull();
    expect(db.unlock(first!)).toBe(true);
  });

  it("persists an ordinary Run and its lifecycle events", () => {
    db.insertRun("run-1", "chat-1", "codex");
    db.insertEvent("run-1", 1, "provider_started", new Date().toISOString(), { provider: "codex" });
    expect(db.getRun("run-1")).toMatchObject({ run_id: "run-1", status: "running" });
    expect(db.getEventsForRun("run-1")).toHaveLength(1);
    expect(db.updateRunCompleted("run-1", "answer", "session-1")).toBe(true);
    expect(db.getRun("run-1")).toMatchObject({ status: "done", final_text_preview: "answer", session_id: "session-1" });
  });

  it("keeps event receipt idempotency in the ordinary Run path", () => {
    const input = {
      event_id: "event-1", source: "health", event_kind: "red",
      idempotency_key: "health:event-1", received_at: "2026-01-01T00:00:00.000Z",
      occurred_at: "2026-01-01T00:00:00.000Z", payload_json: "{}", authority_scope: "health",
    };
    const first = db.createEventReceipt(input);
    const second = db.createEventReceipt(input);
    expect(second.id).toBe(first.id);
    expect(db.getEventReceiptByIdempotencyKey(input.idempotency_key)?.id).toBe(first.id);
  });

  it("retains exact conversation turns for fresh-session continuity", () => {
    db.addConvTurn("chat-1", "user", "hello", "codex");
    db.addConvTurn("chat-1", "assistant", "hi", "codex");
    const context = db.buildConvContext("chat-1");
    expect(context).toContain("User: hello");
    expect(context).toContain("Assistant: hi");
  });

  it("keeps historical legacy tables without exposing retired runtime APIs", () => {
    for (const table of ["conversation_summaries", "compaction_attempts", "project_memories"]) {
      expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeTruthy();
    }

    for (const method of [
      "getConvTurnsForCompaction",
      "getUncompactedConvStats",
      "pruneConvTurns",
      "addCompactionAttempt",
      "getLatestCompactionAttempt",
      "addMemory",
      "findMemoryByText",
      "searchMemories",
      "getMemoryCount",
      "resolveMemory",
    ]) {
      expect(method in db).toBe(false);
    }
  });
});

describe("db.ts public export compatibility", () => {
  it("keeps retained-turn context constants stable", () => {
    expect(DEFAULT_CONTEXT_MAX_CHARS).toBe(24_000);
    expect(DEFAULT_CONTEXT_RECENT_TURN_LIMIT).toBe(200);
  });
});
