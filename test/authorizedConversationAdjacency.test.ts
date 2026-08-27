import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

describe("authorized conversation search adjacency", () => {
  it("keeps conversation adjacency canonical across owner-key configuration changes", () => {
    const db = openDb(":memory:");
    try {
      db.addConvTurn("same-native-id", "assistant", "telegram before", "codex", {
        surfaceIdentity: "telegram:interactive",
        ownerKey: "owner-a",
      });
      db.addConvTurn("same-native-id", "user", "decision marker", "codex", {
        surfaceIdentity: "telegram:interactive",
        ownerKey: "owner-a",
      });
      db.addConvTurn("same-native-id", "assistant", "corrected after allowlist change", "codex", {
        surfaceIdentity: "telegram:interactive",
      });
      db.addConvTurn("same-native-id", "assistant", "discord must not leak", "codex", {
        surfaceIdentity: "discord:interactive",
      });

      const conversationRows = db.searchAuthorizedConvTurns(
        { scope: "conversation", surfaceIdentity: "telegram:interactive", chatKey: "same-native-id" },
        "decision marker",
      );
      expect(conversationRows.map((row) => row.text)).toEqual([
        "telegram before",
        "decision marker",
        "corrected after allowlist change",
      ]);

      const ownerRows = db.searchAuthorizedConvTurns({ scope: "owner", ownerKey: "owner-a" }, "decision marker");
      expect(ownerRows.map((row) => row.text)).toEqual(["telegram before", "decision marker"]);
      expect(ownerRows.some((row) => row.text === "corrected after allowlist change")).toBe(false);
      expect(ownerRows.some((row) => row.text === "discord must not leak")).toBe(false);
    } finally {
      db.close();
    }
  });
});
