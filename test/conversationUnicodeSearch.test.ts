import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("Unicode retained-conversation search", () => {
  it("retrieves matching Cyrillic evidence without crossing chat scope", () => {
    db.addConvTurn("chat:1", "user", "Решение по развёртыванию принято в пятницу");
    db.addConvTurn("chat:2", "user", "Развёртывание другого чата");

    const rows = db.searchConvTurns("chat:1", "развёртыванию");

    expect(rows.filter((row: any) => row.is_match).map((row) => row.text)).toEqual([
      "Решение по развёртыванию принято в пятницу",
    ]);
  });

  it("retrieves matching Japanese evidence", () => {
    db.addConvTurn("chat:1", "assistant", "次回の展開は金曜日です");

    const rows = db.searchConvTurns("chat:1", "展開");

    expect(rows.filter((row: any) => row.is_match).map((row) => row.text)).toEqual([
      "次回の展開は金曜日です",
    ]);
  });
});
