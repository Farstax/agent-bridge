import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { lookupProviderSession, persistProviderSession } from "../src/providers/sessionRuntime.js";

describe("official Antigravity ACP session transition", () => {
  it("does not silently load 1.4.5 sessions that return success with empty history in 1.5.2", () => {
    const db = openDb(":memory:");
    const identity = { surfaceIdentity: "acp:outward", chatKey: "legacy-boundary" };
    try {
      db.putAcpSessionBinding({
        surfaceIdentity: identity.surfaceIdentity, conversationId: identity.chatKey,
        providerId: "agy", acpSessionId: "legacy-1.4.5", runId: null,
      });
      expect(lookupProviderSession(db, identity, "antigravity")).toBeNull();

      persistProviderSession(db, identity, "antigravity", "official-1.5.2");
      expect(lookupProviderSession(db, identity, "antigravity")).toBe("official-1.5.2");
      // Old binding is untouched for controlled rollback and visual Workstream
      // turns remain in the Bridge database independently of ACP sessions.
      expect(db.getAcpSessionBinding(identity, "agy")?.acpSessionId).toBe("legacy-1.4.5");
    } finally {
      db.close();
    }
  });
});
