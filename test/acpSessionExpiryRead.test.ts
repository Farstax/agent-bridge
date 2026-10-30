import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { AcpSessionRepository } from "../src/repositories/acpSessionRepository.js";

describe("session expiry at use", () => {
  it("does not resume stale native and ACP sessions even before maintenance runs", () => {
    const db = openDb(":memory:");
    try {
      const identity = { surfaceIdentity: "acp:outward", chatKey: "acp:test" };
      db.setSession(identity, "codex", "native-old");
      const bindings = new AcpSessionRepository(db.raw);
      bindings.put({ surfaceIdentity: identity.surfaceIdentity, conversationId: identity.chatKey, providerId: "codex", acpSessionId: "acp-old", runId: null });
      db.raw.prepare("UPDATE bridge_state SET codex_session_created_at = datetime('now', '-8 days')").run();
      db.raw.prepare("UPDATE acp_session_bindings SET updated_at = datetime('now', '-8 days')").run();
      expect(db.getSession(identity, "codex")).toBeNull();
      expect(bindings.get(identity, "codex")).toBeNull();
    } finally { db.close(); }
  });
});
