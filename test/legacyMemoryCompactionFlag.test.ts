import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { compactConversation } from "../src/compactConversation.js";
import { handleCommand } from "../src/commands.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";
import { legacyMemoryCompactionEnabled } from "../src/legacyMemoryCompaction.js";
import { extractProjectMemorySidecars, storeProjectMemoryCandidate } from "../src/projectMemory.js";
import type { BridgeConfig } from "../src/types.js";

const FLAG = "BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED";

function makeConfig(dbPath = ":memory:"): BridgeConfig {
  const emptyBot = { token: undefined, command: "", modelPreference: [] };
  return {
    allowedUserIds: new Set(["42"]),
    serviceEnvFile: null,
    serviceKind: null,
    pollIntervalMs: 1000,
    executionMode: "safe",
    asyncEnabled: false,
    dbPath,
    bots: { codex: emptyBot, antigravity: emptyBot, claude: emptyBot },
  };
}

function compactDeps(db: BridgeDb, trigger: "manual" | "preseed" | "capacity_fallback", runCli = vi.fn().mockResolvedValue("should-not-run")) {
  return {
    db,
    runCli,
    botConfig: { command: "claude", modelPreference: ["claude-opus-5"] },
    cliKind: "claude",
    trigger,
  } as const;
}

describe("turn-history continuity canary (issue #477)", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `legacy-memory-canary-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    delete process.env[FLAG];
    delete process.env.BRIDGE_CONTEXT_MAX_CHARS;
    delete process.env.BRIDGE_PRESEED_COMPACT_MODE;
    delete process.env.BRIDGE_PRESEED_COMPACT_CHARS;
    vi.restoreAllMocks();
    db.close();
    rmSync(dbPath, { force: true });
  });

  it("defaults legacy memory and compaction off unless explicitly enabled", () => {
    expect(legacyMemoryCompactionEnabled({})).toBe(false);
    expect(legacyMemoryCompactionEnabled({ [FLAG]: "false" })).toBe(false);
    expect(legacyMemoryCompactionEnabled({ [FLAG]: "true" })).toBe(true);
  });

  it("keeps legacy summary-first context available for explicit rollback", () => {
    process.env[FLAG] = "true";
    db.addConvTurn("chat:1", "user", "covered raw turn", "claude");
    db.addConvSummary("chat:1", 1, 1, "LEGACY SUMMARY");
    db.addConvTurn("chat:1", "assistant", "recent raw turn", "claude");

    const context = db.buildConvContext("chat:1");

    expect(context).toContain("LEGACY SUMMARY");
    expect(context).not.toContain("covered raw turn");
    expect(context).toContain("recent raw turn");
  });

  it("uses bounded exact conversation turns and ignores stored summaries by default", () => {
    db.addConvTurn("chat:1", "user", "covered raw turn must survive", "claude");
    db.addConvSummary("chat:1", 1, 1, "GENERATED SUMMARY MUST NOT APPEAR");
    for (let i = 0; i < 5; i++) {
      db.addConvTurn("chat:1", i % 2 === 0 ? "assistant" : "user", `exact-${i}-${"x".repeat(3_000)}`, "claude");
    }

    const context = db.buildConvContext("chat:1");

    expect(context).toContain("covered raw turn must survive");
    expect(context).not.toContain("GENERATED SUMMARY MUST NOT APPEAR");
    expect(context).toContain("exact-4-");
    expect(context.length).toBeGreaterThan(8_000);
    expect(context.length).toBeLessThanOrEqual(24_500);
  });

  it("honors an explicit context budget while the canary is disabled", () => {
    process.env[FLAG] = "false";
    process.env.BRIDGE_CONTEXT_MAX_CHARS = "4000";
    for (let i = 0; i < 6; i++) db.addConvTurn("chat:1", "user", `turn-${i}-${"x".repeat(1_000)}`, "claude");

    const context = db.buildConvContext("chat:1", 4_000);

    expect(context.length).toBeLessThanOrEqual(4_500);
    expect(context).toContain("turn-5-");
  });

  it.each(["manual", "preseed", "capacity_fallback"] as const)(
    "prevents %s compaction from calling a provider or writing a summary when disabled",
    async (trigger) => {
      process.env[FLAG] = "false";
      db.addConvTurn("chat:1", "user", `raw turn for ${trigger}`, "claude");
      const runCli = vi.fn().mockResolvedValue("unused");

      const result = await compactConversation("chat:1", compactDeps(db, trigger, runCli));

      expect(result.outcome).toBe("failed");
      expect(result.error).toMatch(/disabled/i);
      expect(runCli).not.toHaveBeenCalled();
      expect(db.getLatestConvSummary("chat:1")).toBeNull();
      expect(db.getLatestCompactionAttempt("chat:1")).toBeNull();
    },
  );

  it("does not persist hidden assistant memory sidecars when disabled", () => {
    process.env[FLAG] = "false";
    db.addConvTurn("chat:1", "user", "source turn", "claude");
    const extracted = extractProjectMemorySidecars([
      "Visible answer.",
      '<!-- agent-bridge-memory {"type":"decision","scope":"project","text":"This durable memory must not be written during the canary."} -->',
    ].join("\n"));

    expect(extracted.cleanText).toBe("Visible answer.");
    expect(extracted.candidates).toHaveLength(1);
    const result = storeProjectMemoryCandidate(db, extracted.candidates[0], { chatKey: "chat:1", cliKind: "claude" });

    expect(result.status).toBe("rejected");
    expect(result).toEqual(expect.objectContaining({ reason: expect.stringMatching(/disabled/i) }));
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM project_memories").get() as { n: number }).n).toBe(0);
  });

  it("disables manual compact and removes the high-turn compact nudge", () => {
    process.env[FLAG] = "false";
    for (let i = 0; i < 101; i++) db.addConvTurn("chat:1", "user", `turn ${i}`, "claude");

    const compact = handleCommand("claude", "/compact", { db, chatId: "chat:1", config: makeConfig(dbPath) });
    const status = handleCommand("claude", "/context", { db, chatId: "chat:1", config: makeConfig(dbPath) });

    expect(compact).toEqual({ kind: "message", text: expect.stringMatching(/disabled/i) });
    expect((status as { text: string }).text).not.toMatch(/consider \/compact/i);
    expect((status as { text: string }).text).toMatch(/legacy memory.*disabled/i);
  });

  it("keeps recent/search turn retrieval available while summary and project-memory helpers are disabled", () => {
    db.addConvTurn("chat:1", "user", "older searchable falcon decision", "claude");
    db.addConvSummary("chat:1", 1, 1, "GENERATED SUMMARY");
    db.addMemory({ id: "mem-old", type: "decision", scope: "project", text: "legacy project memory should stay stored" });
    process.env[FLAG] = "false";
    const env = { AGENT_BRIDGE_CONTEXT_DB: dbPath, AGENT_BRIDGE_CHAT_KEY: "chat:1", AGENT_BRIDGE_CLI_KIND: "claude" };

    expect(renderAgentBridgeContext(["--recent", "20"], env)).toContain("older searchable falcon decision");
    expect(renderAgentBridgeContext(["--search", "falcon"], env)).toContain("older searchable falcon decision");
    expect(renderAgentBridgeContext(["--summary"], env)).toMatch(/disabled/i);
    expect(renderAgentBridgeContext(["--memory"], env)).toMatch(/disabled/i);
    expect(renderAgentBridgeContext(["--memory-query", "legacy"], env)).toMatch(/disabled/i);
    expect(renderAgentBridgeContext(["--memory-add-json", JSON.stringify({ type: "decision", text: "A new automatic memory should not be written." })], env)).toMatch(/disabled/i);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM project_memories").get() as { n: number }).n).toBe(1);
  });

  it("does not delete legacy summary or memory rows when toggled off and exposes them again after rollback", () => {
    db.addConvTurn("chat:1", "user", "source", "claude");
    db.addConvSummary("chat:1", 1, 1, "rollback summary");
    db.addMemory({ id: "mem-rollback", type: "decision", scope: "project", text: "rollback memory remains durable" });

    process.env[FLAG] = "false";
    expect(db.buildConvContext("chat:1")).not.toContain("rollback summary");
    expect(db.getMemoryCount()).toBe(0);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM conversation_summaries").get() as { n: number }).n).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM project_memories").get() as { n: number }).n).toBe(1);

    process.env[FLAG] = "true";
    expect(db.buildConvContext("chat:1")).toContain("rollback summary");
    expect(db.getMemoryCount()).toBe(1);
  });

  it("reset clears scoped turn/summary history so rollback cannot resurrect it", () => {
    db.addConvTurn("chat:1", "user", "delete me", "claude");
    db.addConvSummary("chat:1", 1, 1, "delete this summary");
    process.env[FLAG] = "false";

    const reset = handleCommand("claude", "/reset", { db, chatId: "chat:1", config: makeConfig(dbPath) });
    expect(reset?.kind).toBe("message");
    process.env[FLAG] = "true";

    expect(db.getRecentConvTurns("chat:1", 20)).toEqual([]);
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.buildConvContext("chat:1")).toBe("");
  });
});
