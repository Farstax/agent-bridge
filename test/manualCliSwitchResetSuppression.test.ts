import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import {
  applyManualCliSwitchHandoff,
  getUserCliPreference,
  setUserCliPreference,
} from "../src/interactiveBot.js";
import { isHandoffRequired } from "../src/handoffState.js";

describe("manual CLI switch after reset suppression", () => {
  it("atomically prepares handoff, persists the new preference, and clears only this chat's suppression", () => {
    const db = openDb(":memory:");
    try {
      db.setSetting("ctx_suppress:chat:1", "1");
      db.setSetting("ctx_suppress:chat:2", "1");
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");

      applyManualCliSwitchHandoff(db, "chat:1", "claude");

      expect(db.getSetting("ctx_suppress:chat:1")).toBeNull();
      expect(db.getSetting("ctx_suppress:chat:2")).toBe("1");
      expect(db.getSession("chat:1", "claude")).toBeNull();
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(true);
      expect(getUserCliPreference(db, "chat:1")).toBe("claude");
    } finally {
      db.close();
    }
  });

  it("keeps reset suppression and the old preference if destination session preparation fails", () => {
    const db = openDb(":memory:");
    try {
      db.setSetting("ctx_suppress:chat:1", "1");
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");
      vi.spyOn(db, "setSession").mockImplementation(() => {
        throw new Error("simulated session write failure");
      });

      expect(() => applyManualCliSwitchHandoff(db, "chat:1", "claude"))
        .toThrow("simulated session write failure");

      expect(db.getSetting("ctx_suppress:chat:1")).toBe("1");
      expect(db.getSession("chat:1", "claude")).toBe("stale-session");
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
      expect(getUserCliPreference(db, "chat:1")).toBe("codex");
    } finally {
      db.close();
    }
  });

  it("rolls back the cleared session when persisting the handoff marker fails", () => {
    const db = openDb(":memory:");
    try {
      db.setSetting("ctx_suppress:chat:1", "1");
      db.setSession("chat:1", "claude", "stale-session");
      setUserCliPreference(db, "chat:1", "codex");

      const setSetting = db.setSetting.bind(db);
      vi.spyOn(db, "setSetting").mockImplementation((key, value) => {
        if (key.startsWith("handoff_required:")) {
          throw new Error("simulated handoff marker write failure");
        }
        setSetting(key, value);
      });

      expect(() => applyManualCliSwitchHandoff(db, "chat:1", "claude"))
        .toThrow("simulated handoff marker write failure");

      expect(db.getSetting("ctx_suppress:chat:1")).toBe("1");
      expect(db.getSession("chat:1", "claude")).toBe("stale-session");
      expect(isHandoffRequired(db, "chat:1", "claude")).toBe(false);
      expect(getUserCliPreference(db, "chat:1")).toBe("codex");
    } finally {
      db.close();
    }
  });
});
