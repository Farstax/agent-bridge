import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleCommand, isBridgeCommand } from "../src/commands.js";
import { openDb } from "../src/db.js";

describe("advisor user routing", () => {
  it("routes an explicit /advisor request through the active provider instead of Bridge orchestration", () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-routing-"));
    const db = openDb(join(dir, "bridge.sqlite"));
    try {
      expect(isBridgeCommand("/advisor")).toBe(false);
      expect(handleCommand("codex", "/advisor give me an independent view", {
        db,
        chatId: "chat:advisor",
        config: {} as any,
      })).toEqual({ kind: "execute", prompt: "/advisor give me an independent view" });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
