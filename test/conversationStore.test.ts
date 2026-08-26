import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  delete process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT;
  db.close();
});

describe("conversation turns", () => {
  it("returns empty array when no turns exist", () => {
    expect(db.getRecentConvTurns("chat:1", 10)).toEqual([]);
  });

  it("stores and retrieves turns in chronological order", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const turns = db.getRecentConvTurns("chat:1", 10);
    expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "hello"],
      ["assistant", "world"],
    ]);
  });

  it("isolates turns by chat key", () => {
    db.addConvTurn("chat:1", "user", "in chat 1");
    db.addConvTurn("chat:2", "user", "in chat 2");
    expect(db.getRecentConvTurns("chat:1", 10).map((turn) => turn.text)).toEqual(["in chat 1"]);
    expect(db.getRecentConvTurns("chat:2", 10).map((turn) => turn.text)).toEqual(["in chat 2"]);
  });

  it("returns the newest N turns while preserving chronological order", () => {
    for (let i = 0; i < 8; i++) db.addConvTurn("chat:1", "user", `msg ${i}`);
    expect(db.getRecentConvTurns("chat:1", 3).map((turn) => turn.text)).toEqual(["msg 5", "msg 6", "msg 7"]);
  });

  it("supports exact turns after a known turn id", () => {
    db.addConvTurn("chat:1", "user", "before");
    const marker = db.getRecentConvTurns("chat:1", 1)[0];
    db.addConvTurn("chat:1", "assistant", "after one");
    db.addConvTurn("chat:1", "user", "after two");
    expect(db.getRecentConvTurns("chat:1", 10, marker.id).map((turn) => turn.text)).toEqual([
      "after one",
      "after two",
    ]);
  });

  it("stores the provider that produced a turn", () => {
    db.addConvTurn("chat:1", "assistant", "answer", "codex");
    expect(db.getRecentConvTurns("chat:1", 1)[0].cli).toBe("codex");
  });
});

describe("buildConvContext", () => {
  it("returns empty string when no retained turns exist", () => {
    expect(db.buildConvContext("chat:1")).toBe("");
  });

  it("builds handoff context from exact retained turns", () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "world");
    const context = db.buildConvContext("chat:1");
    expect(context).toContain("[Context from previous conversation]");
    expect(context).toContain("User: hello");
    expect(context).toContain("Assistant: world");
    expect(context).toContain("[End context — continue naturally]");
  });

  it("ignores historical generated summaries", () => {
    db.addConvTurn("chat:1", "user", "exact retained evidence");
    const turn = db.getRecentConvTurns("chat:1", 1)[0];
    db.raw.prepare(
      `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
       VALUES (?, ?, ?, ?)`,
    ).run("chat:1", turn.id, turn.id, "LEGACY GENERATED SUMMARY MUST NOT BE USED");

    const context = db.buildConvContext("chat:1");
    expect(context).toContain("exact retained evidence");
    expect(context).not.toContain("LEGACY GENERATED SUMMARY MUST NOT BE USED");
  });

  it("keeps newest turns when the character budget is tight", () => {
    db.addConvTurn("chat:1", "user", "x".repeat(400));
    db.addConvTurn("chat:1", "assistant", "short reply");
    const context = db.buildConvContext("chat:1", 100);
    expect(context).toContain("short reply");
    expect(context).not.toContain("x".repeat(20));
  });

  it("keeps the newest candidate window when history exceeds the default turn limit", () => {
    for (let i = 0; i < 250; i++) db.addConvTurn("chat:1", "user", `turn-${i}`);
    const context = db.buildConvContext("chat:1", 50_000);
    expect(context).toContain("turn-249");
    expect(context).not.toContain("User: turn-0\n");
  });

  it("honours BRIDGE_CONTEXT_RECENT_TURN_LIMIT", () => {
    for (let i = 0; i < 10; i++) db.addConvTurn("chat:1", "user", `turn-${i}`);
    process.env.BRIDGE_CONTEXT_RECENT_TURN_LIMIT = "3";
    const context = db.buildConvContext("chat:1", 50_000);
    expect(context).toContain("turn-9");
    expect(context).not.toContain("turn-6\n");
  });
});

describe("scoped conversation search", () => {
  it("returns matching older turns with adjacent context in chronological order", () => {
    db.addConvTurn("chat:1", "user", "before marker");
    db.addConvTurn("chat:1", "assistant", "decision alpha marker");
    db.addConvTurn("chat:1", "user", "after marker");
    db.addConvTurn("chat:2", "user", "decision alpha other chat");

    const rows = db.searchConvTurns("chat:1", "decision alpha");
    expect(rows.map((row) => row.text)).toEqual(["before marker", "decision alpha marker", "after marker"]);
    expect(rows.filter((row: any) => row.is_match).map((row) => row.text)).toEqual(["decision alpha marker"]);
  });
});

describe("pending messages", () => {
  it("enqueues and dequeues within the owning surface and chat", () => {
    db.enqueueMsg("telegram:codex", "chat:1", { prompt: "do work", chatId: 123, chatType: "private" });
    db.enqueueMsg("telegram:claude", "chat:1", { prompt: "other work", chatId: 123, chatType: "private" });

    expect(db.pendingMsgCount("telegram:codex", "chat:1")).toBe(1);
    expect(db.pendingMsgCount("telegram:claude", "chat:1")).toBe(1);
    expect(db.dequeueMsgs("telegram:codex", "chat:1").map((msg) => msg.prompt)).toEqual(["do work"]);
    expect(db.dequeueMsgs("telegram:claude", "chat:1").map((msg) => msg.prompt)).toEqual(["other work"]);
  });
});

describe("history reset storage", () => {
  it("clears retained turns and historical summaries only for the selected chat", () => {
    db.addConvTurn("chat:1", "user", "delete me");
    db.addConvTurn("chat:2", "user", "keep me");
    const first = db.getRecentConvTurns("chat:1", 1)[0];
    const second = db.getRecentConvTurns("chat:2", 1)[0];
    db.raw.prepare(
      `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
       VALUES (?, ?, ?, ?)`,
    ).run("chat:1", first.id, first.id, "old one");
    db.raw.prepare(
      `INSERT INTO conversation_summaries (chat_key, range_start_turn_id, range_end_turn_id, summary_md)
       VALUES (?, ?, ?, ?)`,
    ).run("chat:2", second.id, second.id, "old two");

    db.clearConvHistory("chat:1");

    expect(db.getRecentConvTurns("chat:1", 10)).toEqual([]);
    expect(db.getRecentConvTurns("chat:2", 10).map((turn) => turn.text)).toEqual(["keep me"]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE chat_key = ?").get("chat:1")).toEqual({ n: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_summaries WHERE chat_key = ?").get("chat:2")).toEqual({ n: 1 });
  });
});
