import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { openDb, type BridgeDb } from "../src/db.js";
import { handleCommand } from "../src/commands.js";
import type { BridgeConfig } from "../src/types.js";

function makeConfig(): BridgeConfig {
  const emptyBot = { token: undefined, command: "", modelPreference: [] };
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    dbPath: ":memory:",
    bots: { codex: emptyBot, antigravity: emptyBot, claude: emptyBot, grok: emptyBot, cursor: emptyBot },
  };
}

describe("/context operator diagnostics", () => {
  let db: BridgeDb;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("shows retained exact-turn status and the supported retrieval path", () => {
    db.addConvTurn("100", "user", "hello there");
    db.addConvTurn("100", "assistant", "hi");

    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    const text = (result as any).text as string;

    expect(text).toContain("Stored: 2 turns");
    expect(text).toContain("Pending queue: 0");
    expect(text).toContain("Retrieval: retained exact turns (`--recent` / `--search`)");
    expect(text).not.toContain("Memory count");
    expect(text).not.toContain("compact");
  });

  it("reports zero stored turns for a fresh chat", () => {
    const result = handleCommand("claude", "/context", { db, chatId: "brand-new-chat", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Stored: 0 turns");
    expect(text).toContain("Latest turn: none");
  });
});

describe("/btw command parsing (Issue #177)", () => {
  let db: BridgeDb;

  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("returns a usage message when no prompt is supplied", () => {
    const result = handleCommand("claude", "/btw", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    expect((result as { text: string }).text).toMatch(/usage/i);
  });

  it("returns a usage message when only whitespace is supplied", () => {
    const result = handleCommand("claude", "/btw    ", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    expect((result as { text: string }).text).toMatch(/usage/i);
  });

  it("returns kind 'btw' with the trimmed prompt when supplied", () => {
    const result = handleCommand("claude", "/btw what does this repo build?", { db, chatId: "100", config: makeConfig() });
    expect(result).toEqual({ kind: "btw", prompt: "what does this repo build?" });
  });

  it("is recognised as a bridge command", () => {
    const result = handleCommand("codex", "/btw quick side question", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("btw");
  });
});

describe("grok command surface", () => {
  let db: BridgeDb;

  beforeEach(() => { db = openDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("resets a grok session", () => {
    db.setSession("100", "grok", "sess-grok");
    const result = handleCommand("grok", "/reset", { db, chatId: "100", config: makeConfig() });
    expect(result).toEqual({
      kind: "message",
      text: "grok session reset. Pending work and conversation history cleared.",
    });
    expect(db.getSession("100", "grok")).toBeNull();
  });

  it("does not expose Codex-only /usage on grok", () => {
    const result = handleCommand("grok", "/usage", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    expect((result as { text: string }).text).toMatch(/codex/i);
  });
});
