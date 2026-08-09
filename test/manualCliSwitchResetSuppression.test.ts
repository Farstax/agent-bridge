import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { applyManualCliSwitchHandoff } from "../src/interactiveBot.js";
import { isHandoffRequired } from "../src/handoffState.js";

describe("manual CLI switch after reset suppression", () => {
  it("clears ctx_suppress for the switched chat while preserving isolation and handoff state", () => {
    const db = openDb(":memory:");
    try {
      db.setSetting("ctx_suppress:chat:1", "1");
      db.setSetting("ctx_suppress:chat:2", "1");
      db.setSession("chat:1", "claude", "stale-session");

      applyManualCliSwitchHandoff(db, "chat:1", "claude");

      expect(db.getSetting("ctx_suppress:chat:1")).toBeNull();
      expect(db.getSetting("ctx_suppress:chat:2")).toBe("1");
      expect(db.getSession("chat:1", "claude")).toBeNull();
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
    } finally {
      db.close();
    }
  });
});
