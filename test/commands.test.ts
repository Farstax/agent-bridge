import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    asyncEnabled: false,
    dbPath: ":memory:",
    bots: { codex: emptyBot, antigravity: emptyBot, claude: emptyBot, kimchi: emptyBot },
  };
}

describe("/context operator diagnostics", () => {
  let db: BridgeDb;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  afterEach(() => {
    delete process.env.BRIDGE_PRESEED_COMPACT_MODE;
    delete process.env.BRIDGE_PRESEED_COMPACT_CHARS;
    db.close();
  });

  it("shows off pre-seed mode by default", () => {
    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    expect(result?.kind).toBe("message");
    const text = (result as any).text as string;
    expect(text).toContain("Pre-seed compact: off");
  });

  it("shows the configured auto pre-seed threshold", () => {
    process.env.BRIDGE_PRESEED_COMPACT_MODE = "auto";
    process.env.BRIDGE_PRESEED_COMPACT_CHARS = "12345";

    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Pre-seed compact: auto (threshold 12345 chars)");
  });

  it("shows uncompacted turn/char counts and memory count", () => {
    db.addConvTurn("100", "user", "hello there");
    db.addConvTurn("100", "assistant", "hi");
    db.addMemory({ id: "mem-1", type: "decision", text: "some durable fact" });

    const result = handleCommand("claude", "/context", { db, chatId: "100", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Uncompacted: 2 turns, 13 chars");
    expect(text).toContain("Memory count: 1");
  });

  it("reports zero uncompacted turns and zero memory count for a fresh chat", () => {
    const result = handleCommand("claude", "/context", { db, chatId: "brand-new-chat", config: makeConfig() });
    const text = (result as any).text as string;

    expect(text).toContain("Uncompacted: 0 turns, 0 chars");
    expect(text).toContain("Memory count: 0");
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

const advisorEnvKeys = [
  "BRIDGE_ADVISOR_ENABLED",
  "BRIDGE_ADVISOR_MODE",
  "BRIDGE_ADVISOR_CHAIN",
  "BRIDGE_ADVISOR_REPO_ENV_FILE",
  "BRIDGE_ADVISOR_SYSTEMD_ENV_FILE",
] as const;

describe("/advisor status operator diagnostics", () => {
  let db: BridgeDb;
  let dir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    dir = mkdtempSync(join(tmpdir(), "advisor-command-status-"));
  });

  afterEach(() => {
    for (const key of advisorEnvKeys) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  function statusText(): string {
    const result = handleCommand("claude", "/advisor status", {
      db,
      chatId: "100",
      config: makeConfig(),
    });
    expect(result?.kind).toBe("message");
    return (result as { text: string }).text;
  }

  it("reports runtime provenance, matching files and no drift without exposing unrelated secrets", () => {
    const repo = join(dir, ".env.shared");
    const systemd = join(dir, "agent-bridge-shared");
    const lines = [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_MODE=manual",
      "BRIDGE_ADVISOR_CHAIN=claude:fable",
      "OPENAI_API_KEY=must-not-appear",
    ];
    writeFileSync(repo, `${lines.join("\n")}\n`);
    writeFileSync(systemd, `${lines.join("\n")}\n`);
    process.env.BRIDGE_ADVISOR_ENABLED = "true";
    process.env.BRIDGE_ADVISOR_MODE = "manual";
    process.env.BRIDGE_ADVISOR_CHAIN = "claude:fable";
    process.env.BRIDGE_ADVISOR_REPO_ENV_FILE = repo;
    process.env.BRIDGE_ADVISOR_SYSTEMD_ENV_FILE = systemd;

    const text = statusText();

    expect(text).toContain("Effective source: process environment (origin not retained)");
    expect(text).toContain(`Effective chain matches: ${systemd} and ${repo}`);
    expect(text).toContain("Configuration drift: none detected.");
    expect(text).not.toContain("must-not-appear");
    expect(text).not.toContain("OPENAI_API_KEY");
  });

  it("warns on conflicting advisor keys without displaying the stale repository value", () => {
    const repo = join(dir, ".env.shared");
    const systemd = join(dir, "agent-bridge-shared");
    writeFileSync(repo, [
      "BRIDGE_ADVISOR_ENABLED=true",
      "BRIDGE_ADVISOR_CHAIN=claude:new",
      "ANTHROPIC_API_KEY=must-not-appear",
      "",
    ].join("\n"));
    writeFileSync(systemd, [
      "BRIDGE_ADVISOR_ENABLED=false",
      "BRIDGE_ADVISOR_CHAIN=claude:old",
      "",
    ].join("\n"));
    process.env.BRIDGE_ADVISOR_ENABLED = "false";
    process.env.BRIDGE_ADVISOR_CHAIN = "claude:old";
    process.env.BRIDGE_ADVISOR_REPO_ENV_FILE = repo;
    process.env.BRIDGE_ADVISOR_SYSTEMD_ENV_FILE = systemd;

    const text = statusText();

    expect(text).toContain(`Effective chain matches: ${systemd}`);
    expect(text).toContain("Configuration drift: BRIDGE_ADVISOR_ENABLED, BRIDGE_ADVISOR_CHAIN differ");
    expect(text).toContain("restart the affected Agent Bridge services");
    expect(text).not.toContain("claude:new");
    expect(text).not.toContain("must-not-appear");
    expect(text).not.toContain("ANTHROPIC_API_KEY");
  });

  it("reports unavailable comparison evidence without producing a false drift warning", () => {
    process.env.BRIDGE_ADVISOR_ENABLED = "true";
    process.env.BRIDGE_ADVISOR_CHAIN = "claude:runtime";
    process.env.BRIDGE_ADVISOR_REPO_ENV_FILE = join(dir, "missing-repo");
    process.env.BRIDGE_ADVISOR_SYSTEMD_ENV_FILE = join(dir, "missing-systemd");

    const text = statusText();

    expect(text).toContain("Effective chain matches: no readable configured file");
    expect(text).toContain("Configuration drift: not evaluated because both configuration files are not readable.");
    expect(text).not.toContain("Configuration drift: BRIDGE_ADVISOR_");
  });
});
