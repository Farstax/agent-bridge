import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventReceiptRepository } from "../src/repositories/eventReceiptRepository.js";
import { openDb, DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_RECENT_TURN_LIMIT } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => { db = openDb(":memory:"); });
afterEach(() => { db.close(); });

describe("BridgeDb ordinary Run state", () => {
  it("keeps sessions isolated by chat and provider", () => {
    db.setSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "codex", "codex-1");
    db.setSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "claude", "claude-1");
    db.setSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-2" }, "codex", "codex-2");
    expect(db.getSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "codex")).toBe("codex-1");
    expect(db.getSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "claude")).toBe("claude-1");
    expect(db.getSession( { surfaceIdentity: "telegram:interactive", chatKey: "chat-2" }, "codex")).toBe("codex-2");
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
    db.insertRun("run-1", { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "codex");
    db.insertEvent("run-1", 1, "provider_started", new Date().toISOString(), { provider: "codex" });
    expect(db.getRun("run-1")).toMatchObject({ run_id: "run-1", status: "running" });
    expect(db.getEventsForRun("run-1")).toHaveLength(1);
    expect(db.updateRunCompleted("run-1", "answer", "session-1")).toBe(true);
    expect(db.getRun("run-1")).toMatchObject({ status: "done", final_text_preview: "answer", session_id: "session-1" });
  });

  it.each(["done", "failed", "cancelled"] as const)("keeps the first repository terminal result when later writers follow %s", (first) => {
    const writers = {
      done: () => db.updateRunCompleted("terminal-race", "original answer", "original session"),
      failed: () => db.updateRunFailed("terminal-race", "original error"),
      cancelled: () => db.updateRunCancelled("terminal-race", "original cancellation"),
    };
    db.insertRun("terminal-race", { surfaceIdentity: "telegram:interactive", chatKey: "chat-1" }, "codex");
    expect(writers[first]()).toBe(true);
    const original = db.getRun("terminal-race");
    for (const writer of Object.values(writers)) expect(writer()).toBe(false);
    expect(db.getRun("terminal-race")).toEqual(original);
  });

  it("uses one durable receipt-admission decision across both entry points and connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-receipt-admission-"));
    const firstDb = openDb(join(dir, "bridge.sqlite"));
    try {
      const secondDb = openDb(join(dir, "bridge.sqlite"));
      try {
        const input = {
          event_id: "event-a", source: "health", event_kind: "red",
          idempotency_key: "health:event-a", received_at: "2026-01-01T00:00:00.000Z",
          occurred_at: "2026-01-01T00:00:00.000Z", payload_json: "{}",
          authority_scope: "health",
        };

        // The legacy caller and the new delivery caller share the same unique key.
        const first = firstDb.createEventReceipt(input);
        expect(firstDb.createEventReceipt(input).id).toBe(first.id);
        expect(firstDb.getEventReceiptByIdempotencyKey(input.idempotency_key)?.id).toBe(first.id);
        expect(firstDb.claimEventReceiptDispatch(first.id)).toBe(true);
        const duplicate = secondDb.admitEventReceipt({ ...input, event_id: "retry-a", payload_json: '{"retry":true}' });
        expect(duplicate.created).toBe(false);
        expect(duplicate.receipt).toMatchObject({ id: first.id, event_id: "event-a", status: "dispatching", payload_json: "{}" });

        // Admission in the reverse order also preserves the original row and status.
        const next = { ...input, event_id: "event-b", idempotency_key: "health:event-b" };
        const admitted = secondDb.admitEventReceipt(next);
        expect(admitted.created).toBe(true);
        expect(secondDb.claimEventReceiptDispatch(admitted.receipt.id)).toBe(true);
        secondDb.finishEventReceipt(admitted.receipt.id, { status: "failed", error_class: "test_failure" });
        expect(firstDb.createEventReceipt({ ...next, event_id: "retry-b" }))
          .toMatchObject({ id: admitted.receipt.id, event_id: "event-b", status: "failed", error_class: "test_failure" });
        expect((firstDb.raw.prepare("SELECT COUNT(*) AS n FROM event_receipts WHERE idempotency_key IN (?, ?)").get(
          input.idempotency_key, next.idempotency_key,
        ) as { n: number }).n).toBe(2);
      } finally {
        secondDb.close();
      }
    } finally {
      firstDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a receipt when retention races duplicate admission", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-receipt-retention-"));
    const first = openDb(join(dir, "bridge.sqlite"));
    const second = openDb(join(dir, "bridge.sqlite"));
    try {
      const repo = new EventReceiptRepository(first.raw);
      const input = { event_id: "event", source: "health", event_kind: "red", idempotency_key: "health:retention", received_at: "2020-01-01T00:00:00.000Z", occurred_at: "2020-01-01T00:00:00.000Z", payload_json: "{}", authority_scope: "health" };
      const receipt = repo.createReceipt(input);
      repo.claimDispatch(receipt.id);
      repo.finish(receipt.id, { status: "completed" });
      const read = repo.getByIdempotencyKey.bind(repo);
      repo.getByIdempotencyKey = (key) => {
        try { second.raw.pragma("busy_timeout = 0"); new EventReceiptRepository(second.raw).pruneSettled("health", "2021-01-01T00:00:00.000Z"); }
        catch (error) { if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error; }
        return read(key);
      };
      expect(repo.admitReceipt(input)).toMatchObject({ created: false, receipt: { id: receipt.id } });
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
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
    expect(DEFAULT_CONTEXT_MAX_CHARS).toBe(50_000);
    expect(DEFAULT_CONTEXT_RECENT_TURN_LIMIT).toBe(200);
  });

  it("has no dead chat-repo compatibility surface (issue #930)", () => {
    const db = openDb(":memory:");
    try {
      expect((db as unknown as Record<string, unknown>).getChatRepo).toBeUndefined();
      expect((db as unknown as Record<string, unknown>).setChatRepo).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
