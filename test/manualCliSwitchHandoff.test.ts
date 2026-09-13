import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import {
  applyManualCliSwitchHandoff,
  getUserCliPreference,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { isHandoffRequired } from "../src/handoffState.js";

describe("manual CLI switch handoff", () => {
  it("atomically prepares handoff and persists the new preference", () => {
    const db = openDb(":memory:");
    try {
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");
      applyManualCliSwitchHandoff(db, "chat:1", "claude");
      expect(db.getSession("chat:1", "claude")).toBeNull();
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
      expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    } finally { db.close(); }
  });

  it("keeps the old preference if destination session preparation fails", () => {
    const db = openDb(":memory:");
    try {
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");
      vi.spyOn(db, "setSession").mockImplementation(() => { throw new Error("simulated session write failure"); });
      expect(() => applyManualCliSwitchHandoff(db, "chat:1", "claude")).toThrow("simulated session write failure");
      expect(db.getSession("chat:1", "claude")).toBe("stale-session");
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
      expect(getUserCliPreference(db, "chat:1")).toBe("codex");
    } finally { db.close(); }
  });

  it("rolls back the cleared session when persisting the handoff marker fails", () => {
    const db = openDb(":memory:");
    try {
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");
      const setSetting = db.setSetting.bind(db);
      vi.spyOn(db, "setSetting").mockImplementation((key, value) => {
        if (key.startsWith("handoff_required:")) throw new Error("simulated handoff marker write failure");
        setSetting(key, value);
      });
      expect(() => applyManualCliSwitchHandoff(db, "chat:1", "claude")).toThrow("simulated handoff marker write failure");
      expect(db.getSession("chat:1", "claude")).toBe("stale-session");
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
      expect(getUserCliPreference(db, "chat:1")).toBe("codex");
    } finally { db.close(); }
  });
});
