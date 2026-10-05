import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  markHandoffRequired,
  isHandoffRequired,
  clearHandoffRequired,
} from "../src/handoffState.js";

let db: BridgeDb;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("handoff state", () => {
  it("is not required by default", () => {
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(false);
  });

  it("becomes required after marking", () => {
    markHandoffRequired(db, "telegram:interactive", "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(true);
  });

  it("is isolated per chat key", () => {
    markHandoffRequired(db, "telegram:interactive", "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:2", "claude")).toBe(false);
  });

  it("is isolated per CLI kind within the same chat", () => {
    markHandoffRequired(db, "telegram:interactive", "chat:1", "claude", "fallback");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "codex")).toBe(false);
  });

  it("clears on demand", () => {
    markHandoffRequired(db, "telegram:interactive", "chat:1", "claude", "fallback");
    clearHandoffRequired(db, "telegram:interactive", "chat:1", "claude");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(false);
  });

  it("clearing an already-clear flag is a no-op, not an error", () => {
    expect(() => clearHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).not.toThrow();
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(false);
  });

  it("keeps the marker durable until successful provider state commit", () => {
    markHandoffRequired(db, "telegram:interactive", "chat:1", "claude", "manual switch");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(true);
    clearHandoffRequired(db, "telegram:interactive", "chat:1", "claude");
    expect(isHandoffRequired(db, "telegram:interactive", "chat:1", "claude")).toBe(false);
  });
});
