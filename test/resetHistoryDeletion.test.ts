import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { handleCommand } from "../src/commands.js";

describe("/reset conversation evidence deletion", () => {
  it("clears turns and summaries only for the current conversation scope", () => {
    const db = openDb(":memory:");
    try {
      db.addConvTurn("chat:1", "user", "current conversation evidence", "claude");
      db.addConvSummary("chat:1", 1, 1, "Current objective:\n- current conversation");
      db.addConvTurn("chat:2", "user", "other conversation evidence", "claude");
      db.addConvSummary("chat:2", 2, 2, "Current objective:\n- other conversation");
      db.setSession("chat:1", "claude", "session-current");
      db.setSession("chat:2", "claude", "session-other");

      const config = {
        allowedUserIds: new Set(["42"]),
        serviceEnvFile: null,
        serviceKind: "claude",
        pollIntervalMs: 1000,
        executionMode: "safe",
        dbPath: ":memory:",
        bots: {
          codex: { command: "codex", modelPreference: [] },
          antigravity: { command: "agy", modelPreference: [] },
          claude: { command: "claude", modelPreference: [] },
        },
      } as any;

      const result = handleCommand("claude", "/reset", {
        db,
        chatId: "chat:1",
        config,
        surfaceIdentity: "telegram:interactive",
      });

      expect(result).toEqual({
        kind: "message",
        text: "claude session reset. Pending work and conversation history cleared.",
      });
      expect(db.getSession("chat:1", "claude")).toBeNull();
      expect(db.getRecentConvTurns("chat:1", 100)).toEqual([]);
      expect(db.getLatestConvSummary("chat:1")).toBeNull();

      expect(db.getSession("chat:2", "claude")).toBe("session-other");
      expect(db.getRecentConvTurns("chat:2", 100).map((turn) => turn.text)).toEqual(["other conversation evidence"]);
      expect(db.getLatestConvSummary("chat:2")?.summary_md).toContain("other conversation");
    } finally {
      db.close();
    }
  });
});
