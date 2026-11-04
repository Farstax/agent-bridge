import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/repositories/conversationRepository.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE conversation_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key TEXT NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    cli TEXT,
    surface_identity TEXT,
    owner_key TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return new ConversationRepository(db);
}

describe("bounded outward Workstream history pages (#1435)", () => {
  it("returns the latest 50 complete exchanges, then all older turns without duplicates or gaps", () => {
    const repo = fixture();
    for (let i = 0; i < 105; i++) {
      repo.addConvTurn("s", "user", `question-${i}`, undefined, { surfaceIdentity: "acp" });
      repo.addConvTurn("s", "assistant", `answer-${i}`, undefined, { surfaceIdentity: "acp" });
    }
    const first = repo.getConvHistoryPage("s", 50, undefined, "acp");
    expect(first.turnCount).toBe(105);
    expect(first.turns).toHaveLength(100);
    expect(first.turns[0]).toMatchObject({ text: "question-55", ordinal: 55 });
    expect(first.turns.at(-1)).toMatchObject({ text: "answer-104", ordinal: 104 });
    expect(first.nextCursor).toBeTypeOf("number");

    const second = repo.getConvHistoryPage("s", 50, first.nextCursor!, "acp");
    expect(second.turns).toHaveLength(100);
    expect(second.turns[0]).toMatchObject({ text: "question-5", ordinal: 5 });
    expect(second.nextCursor).toBeTypeOf("number");
    const last = repo.getConvHistoryPage("s", 50, second.nextCursor!, "acp");
    expect(last.turns).toHaveLength(10);
    expect(last.nextCursor).toBeNull();
    expect([...last.turns, ...second.turns, ...first.turns].map((t) => t.id)).toEqual(
      Array.from({ length: 210 }, (_, index) => index + 1),
    );
  });

  it("does not split an exchange and ignores newer turns added during paging", () => {
    const repo = fixture();
    for (let i = 0; i < 52; i++) {
      repo.addConvTurn("s", "user", `u${i}`, undefined, { surfaceIdentity: "acp" });
      repo.addConvTurn("s", "assistant", `a${i}`, undefined, { surfaceIdentity: "acp" });
    }
    const first = repo.getConvHistoryPage("s", 50, undefined, "acp");
    repo.addConvTurn("s", "user", "concurrent", undefined, { surfaceIdentity: "acp" });
    expect(repo.getConvHistoryPage("s", 50, first.nextCursor!, "acp").turns.map((t) => t.text))
      .toEqual(["u0", "a0", "u1", "a1"]);
  });

  it("isolates conversation and surface scope, including legacy null provenance", () => {
    const repo = fixture();
    repo.addConvTurn("s", "user", "own", undefined, { surfaceIdentity: "acp" });
    repo.addConvTurn("s", "assistant", "legacy");
    repo.addConvTurn("s", "user", "foreign-surface", undefined, { surfaceIdentity: "telegram" });
    repo.addConvTurn("other", "user", "other-chat", undefined, { surfaceIdentity: "acp" });
    expect(repo.getConvHistoryPage("s", 50, undefined, "acp").turns.map((t) => t.text))
      .toEqual(["own", "legacy"]);
  });

  it("rejects invalid page sizes and cursors", () => {
    const repo = fixture();
    expect(() => repo.getConvHistoryPage("s", 51)).toThrow("invalid history page size");
    expect(() => repo.getConvHistoryPage("s", 50, 0)).toThrow("invalid history cursor");
    expect(() => repo.getConvHistoryPage("s", 50, 1.2)).toThrow("invalid history cursor");
  });
});
