import { expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

it("requires an authorized owner scope to find another conversation", () => {
  const path = join(tmpdir(), `issue482-red-${Date.now()}.sqlite`);
  const db = openDb(path);
  try {
    db.addConvTurn("chat:1", "user", "current conversation", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    db.addConvTurn("chat:2", "user", "cross conversation evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
    const output = renderAgentBridgeContext(["--search", "cross conversation", "--scope", "owner"], {
      AGENT_BRIDGE_CONTEXT_DB: path,
      AGENT_BRIDGE_CHAT_KEY: "chat:1",
      AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive",
      AGENT_BRIDGE_OWNER_KEY: "owner-a",
    });
    expect(output).toContain("cross conversation evidence");
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
