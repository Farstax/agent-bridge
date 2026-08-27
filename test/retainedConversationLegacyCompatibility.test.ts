import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

describe("retained conversation legacy compatibility", () => {
  it("keeps the no-surface clear path destructive for legacy unprovenanced state", () => {
    const db = openDb(":memory:");
    try {
      db.addConvTurn("legacy-chat", "user", "legacy turn", "claude");
      db.addConvSummary("legacy-chat", 1, 1, "Current objective:\n- legacy summary");

      db.clearConvHistory("legacy-chat");

      expect(db.getRecentConvTurns("legacy-chat", 20)).toEqual([]);
      expect(db.getLatestConvSummary("legacy-chat")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("does not physically delete an unprovenanced retired summary from a surfaced reset", () => {
    const db = openDb(":memory:");
    try {
      db.addConvTurn("42", "user", "telegram turn", "claude", {
        surfaceIdentity: "telegram:interactive",
        ownerKey: "owner-a",
      });
      db.addConvSummary("42", 1, 1, "Current objective:\n- historical summary");

      db.clearConvHistory("42", "telegram:interactive");

      expect(db.getConvStatus("42", "telegram:interactive").turnCount).toBe(0);
      expect(db.getConvStatus("42", "telegram:interactive").latestSummaryAt).toBeNull();
      expect(db.getLatestConvSummary("42")?.summary_md).toContain("historical summary");
    } finally {
      db.close();
    }
  });
});
