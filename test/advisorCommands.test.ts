import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { handleCommand, isBridgeCommand } from "../src/commands.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  allowedUserIds: new Set(), serviceEnvFile: null, serviceKind: null,
  pollIntervalMs: 1000, executionMode: "safe", asyncEnabled: false, dbPath: ":memory:",
  bots: {
    codex: { token: undefined, command: "codex", modelPreference: [] },
    claude: { token: undefined, command: "claude", modelPreference: [] },
    antigravity: { token: undefined, command: "agy", modelPreference: [] },
  },
};

describe("advisor commands", () => {
  it("recognizes advisor subcommands and preserves their arguments", () => {
    const db = openDb(":memory:");
    expect(isBridgeCommand("/advisor ask Should we split this? ")).toBe(true);
    expect(handleCommand("codex", "/advisor ask Should we split this?", { db, chatId: "c", config }))
      .toMatchObject({ kind: "advisor", action: "ask", task: "Should we split this?", chatKey: "c" });
    expect(handleCommand("codex", "/advisor review", { db, chatId: "c", config }))
      .toMatchObject({ kind: "advisor", action: "review", chatKey: "c" });
    db.close();
  });

  it("returns advisor status without invoking a model", () => {
    const db = openDb(":memory:");
    const result = handleCommand("codex", "/advisor status", { db, chatId: "c", config });
    expect(result).toMatchObject({ kind: "message" });
    expect((result as any).text).toMatch(/Advisor: (enabled|disabled)/);
    db.close();
  });
});
