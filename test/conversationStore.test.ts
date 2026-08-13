// test/conversationStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDb, BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  delete process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
});

describe("conversation turns", () => {
  it("returns empty array when no turns exist", () => {
    expect(db.getRecentConvTurns("chat:1", 10)).toEqual([]);
  });

  it("stores and retrieves turns in order", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const turns = db.getRecentConvTurns("chat:1", 10);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].text).toBe("hello");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toBe("world");
  });

  it("isolates turns by chatKey", () => {
    db.addConvTurn("chat:1", "user", "in chat 1");
    db.addConvTurn("chat:2", "user", "in chat 2");
    expect(db.getRecentConvTurns("chat:1", 10)).toHaveLength(1);
    expect(db.getRecentConvTurns("chat:2", 10)).toHaveLength(1);
  });

  it("respects limit — returns most recent N turns", () => {
    for (let i = 0; i < 8; i++) db.addConvTurn("chat:1", "user", `msg ${i}`);
    const turns = db.getRecentConvTurns("chat:1", 3);
    expect(turns).toHaveLength(3);
    expect(turns[2].text).toBe("msg 7");
  });

  it("stores optional cli field", () => {
    db.addConvTurn("chat:1", "user", "hi", "codex");
    const turns = db.getRecentConvTurns("chat:1", 1);
    expect(turns[0].cli).toBe("codex");
  });

  it("filters turns by sinceId", () => {
    db.addConvTurn("chat:1", "user", "before");
    const [before] = db.getRecentConvTurns("chat:1", 1);
    db.addConvTurn("chat:1", "assistant", "after");
    const turns = db.getRecentConvTurns("chat:1", 10, before.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("after");
  });

  it("returns the NEWEST N turns after sinceId, not the oldest N, when more than the limit exist", () => {
    const [marker] = (() => {
      db.addConvTurn("chat:1", "user", "summary marker");
      return db.getRecentConvTurns("chat:1", 1);
    })();
    // 250 turns after the summary marker, well beyond a 200-item candidate limit.
    for (let i = 0; i < 250; i++) db.addConvTurn("chat:1", "user", `turn-${i}`);

    const turns = db.getRecentConvTurns("chat:1", 200, marker.id);
    expect(turns).toHaveLength(200);
    // Must be the newest 200 (turn-50..turn-249), not the oldest 200 (turn-0..turn-199).
    expect(turns[0].text).toBe("turn-50");
    expect(turns[turns.length - 1].text).toBe("turn-249");
    // Still returned oldest-first for chronological prompt rendering.
    expect(turns.map((t) => t.text)).toEqual(turns.map((t) => t.text).slice().sort((a, b) => {
      const ai = Number(a.split("-")[1]);
      const bi = Number(b.split("-")[1]);
      return ai - bi;
    }));
  });
});

describe("buildConvContext", () => {
  it("returns empty string when no turns", () => {
    expect(db.buildConvContext("chat:1")).toBe("");
  });

  it("wraps turns in context block", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const ctx = db.buildConvContext("chat:1");
    expect(ctx).toContain("[Context from previous conversation]");
    expect(ctx).toContain("User: hello");
    expect(ctx).toContain("Assistant: world");
    expect(ctx).toContain("[End context — continue naturally]");
  });

  it("includes summary above turns when one exists", () => {
    db.addConvTurn("chat:1", "user", "turn1");
    const [t1] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t1.id, t1.id, "## Summary\nObjective: fix bug");
    db.addConvTurn("chat:1", "assistant", "turn2");
    const ctx = db.buildConvContext("chat:1");
    expect(ctx).toContain("## Summary");
    expect(ctx).toContain("Assistant: turn2");
  });

  it("excludes covered turns from the prompt while they remain recoverable evidence (issue #349)", () => {
    // Bounded prompt construction must stay bounded even though turns are
    // now retained past compaction: a covered turn stays out of the prompt
    // (filtered by the summary's range_end_turn_id) but is not deleted from
    // conversation_turns.
    db.addConvTurn("chat:1", "user", "covered turn");
    const [t1] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t1.id, t1.id, "## Summary\nObjective: fix bug");
    db.addConvTurn("chat:1", "assistant", "fresh turn");

    const ctx = db.buildConvContext("chat:1");
    expect(ctx).not.toContain("covered turn");
    expect(ctx).toContain("fresh turn");

    const raw = (db as any).raw as import("better-sqlite3").Database;
    const stillPresent = raw
      .prepare(`SELECT text FROM conversation_turns WHERE chat_key = ? AND text = ?`)
      .get("chat:1", "covered turn");
    expect(stillPresent).toBeTruthy();
  });

  it("excludes turns that exceed the char budget", () => {
    // Two turns: first is large (exceeds budget), second is small
    db.addConvTurn("chat:1", "user", "x".repeat(400));   // older
    db.addConvTurn("chat:1", "assistant", "short reply"); // newer
    // budget of 100 — only the short newer turn should fit
    const ctx = db.buildConvContext("chat:1", 100);
    expect(ctx).toContain("short reply");
    expect(ctx).not.toContain("x".repeat(10)); // large turn excluded
  });

  it("always includes summary even when it alone exceeds char budget", () => {
    db.addConvTurn("chat:1", "user", "t1");
    const [t1] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t1.id, t1.id, "A".repeat(200));
    const ctx = db.buildConvContext("chat:1", 10); // tiny budget
    expect(ctx).toContain("A".repeat(200));
  });

  it("includes newest turns first within budget, oldest dropped", () => {
    for (let i = 1; i <= 10; i++) {
      db.addConvTurn("chat:1", "user", `turn_number_${i}_end`);
    }
    // budget tight enough to exclude early turns but include recent ones
    const ctx = db.buildConvContext("chat:1", 120);
    expect(ctx).toContain("turn_number_10_end");
    expect(ctx).not.toContain("turn_number_1_end");
  });

  it("preserves the newest turns when more than 200 turns exist after the latest summary", () => {
    db.addConvTurn("chat:1", "user", "marker");
    const [marker] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", marker.id, marker.id, "Current objective:\n- ongoing work");
    for (let i = 0; i < 250; i++) db.addConvTurn("chat:1", "user", `turn-${i}`);

    // Generous budget so the candidate-fetch cap (not the char budget) is what's under test.
    const ctx = db.buildConvContext("chat:1", 50_000);
    expect(ctx).toContain("turn-249"); // newest turn must survive
    expect(ctx).not.toContain("turn-0\n"); // oldest turn beyond the 200 candidate cap must not
  });

  it("respects BRIDGE_CONTEXT_RECENT_TURN_LIMIT to widen or narrow the candidate cap", () => {
    for (let i = 0; i < 10; i++) db.addConvTurn("chat:1", "user", `turn-${i}`);

    process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT = "3";
    const narrow = db.buildConvContext("chat:1", 50_000);
    expect(narrow).toContain("turn-9");
    expect(narrow).not.toContain("turn-6\n");

    process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT = "10";
    const wide = db.buildConvContext("chat:1", 50_000);
    expect(wide).toContain("turn-0");
  });
});

describe("pending messages", () => {
  it("returns 0 when no pending messages", () => {
    expect(db.pendingMsgCount("test", "chat:1")).toBe(0);
  });

  it("enqueues and dequeues a message", () => {
    db.enqueueMsg("test", "chat:1", { prompt: "do work", chatId: 123, chatType: "private" });
    expect(db.pendingMsgCount("test", "chat:1")).toBe(1);
    const msgs = db.dequeueMsgs("test", "chat:1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].prompt).toBe("do work");
    expect(msgs[0].chatId).toBe(123);
  });

  it("deletePendingMsg removes the row", () => {
    db.enqueueMsg("test", "chat:1", { prompt: "x", chatId: 1, chatType: "private" });
    const [msg] = db.dequeueMsgs("test", "chat:1");
    db.deletePendingMsg(msg.id);
    expect(db.pendingMsgCount("test", "chat:1")).toBe(0);
  });

  it("isolates queue by chatKey", () => {
    db.enqueueMsg("test", "chat:1", { prompt: "a", chatId: 1, chatType: "private" });
    db.enqueueMsg("test", "chat:2", { prompt: "b", chatId: 2, chatType: "private" });
    expect(db.pendingMsgCount("test", "chat:1")).toBe(1);
    expect(db.pendingMsgCount("test", "chat:2")).toBe(1);
  });

  it("only exposes queued rows to their owning surface", () => {
    db.enqueueMsg("telegram:codex", "chat:1", { prompt: "codex work", chatId: 1, chatType: "private" });
    db.enqueueMsg("telegram:claude", "chat:1", { prompt: "claude work", chatId: 1, chatType: "private" });

    expect(db.pendingMsgCount("telegram:codex", "chat:1")).toBe(1);
    expect(db.pendingMsgCount("telegram:claude", "chat:1")).toBe(1);
    expect(db.dequeueMsgs("telegram:codex", "chat:1").map((msg) => msg.prompt)).toEqual(["codex work"]);
    expect(db.dequeueMsgs("telegram:claude", "chat:1").map((msg) => msg.prompt)).toEqual(["claude work"]);
  });
});

describe("conversation summaries", () => {
  it("getLatestConvSummary returns null when none exist", () => {
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
  });

  it("stores and retrieves a summary", () => {
    db.addConvTurn("chat:1", "user", "t1");
    const [t] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t.id, t.id, "## Summary\nObjective: build feature");
    const s = db.getLatestConvSummary("chat:1");
    expect(s).not.toBeNull();
    expect(s!.summary_md).toContain("build feature");
  });

  it("returns only the latest summary when multiple exist", () => {
    db.addConvTurn("chat:1", "user", "t1");
    const [t] = db.getRecentConvTurns("chat:1", 1);
    db.addConvSummary("chat:1", t.id, t.id, "first");
    db.addConvSummary("chat:1", t.id, t.id, "second");
    expect(db.getLatestConvSummary("chat:1")!.summary_md).toBe("second");
  });
});

describe("pruneConvTurns", () => {
  it("deletes turns up to and including the given id", () => {
    db.addConvTurn("chat:1", "user", "a");
    db.addConvTurn("chat:1", "assistant", "b");
    db.addConvTurn("chat:1", "user", "c");
    const all = db.getRecentConvTurns("chat:1", 10);
    expect(all.length).toBe(3);
    const cutoff = all[1].id; // prune first two turns
    db.pruneConvTurns("chat:1", cutoff);
    const remaining = db.getRecentConvTurns("chat:1", 10);
    expect(remaining.length).toBe(1);
    expect(remaining[0].text).toBe("c");
  });

  it("does not delete turns from other chat keys", () => {
    db.addConvTurn("chat:1", "user", "keep");
    db.addConvTurn("chat:2", "user", "prune me");
    const t2 = db.getRecentConvTurns("chat:2", 1)[0];
    db.pruneConvTurns("chat:2", t2.id);
    expect(db.getRecentConvTurns("chat:1", 10).length).toBe(1);
    expect(db.getRecentConvTurns("chat:2", 10).length).toBe(0);
  });

  it("is a no-op when id is below all stored turns", () => {
    db.addConvTurn("chat:1", "user", "x");
    db.pruneConvTurns("chat:1", 0);
    expect(db.getRecentConvTurns("chat:1", 10).length).toBe(1);
  });
});

describe("getConvStatus", () => {
  it("returns zeros and nulls for new chatKey", () => {
    const s = db.getConvStatus("chat:1", "test");
    expect(s.turnCount).toBe(0);
    expect(s.pendingCount).toBe(0);
    expect(s.latestSummaryAt).toBeNull();
    expect(s.latestTurnAt).toBeNull();
  });

  it("reflects stored data", () => {
    db.addConvTurn("chat:1", "user", "hi");
    db.enqueueMsg("test", "chat:1", { prompt: "q", chatId: 1, chatType: "private" });
    const s = db.getConvStatus("chat:1", "test");
    expect(s.turnCount).toBe(1);
    expect(s.pendingCount).toBe(1);
    expect(s.latestTurnAt).not.toBeNull();
  });
});
