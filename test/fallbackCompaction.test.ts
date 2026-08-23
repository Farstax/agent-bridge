import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  parseCompactionProviderChain,
  runCapacityFallbackCompaction,
  selectCapacityFallbackCompactionTarget,
} from "../src/fallbackCompaction.js";

function compactJson(summaryMd: string): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: [] });
}

describe("healthy capacity-fallback compaction", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED = "true";
    dbPath = join(tmpdir(), `fallback-compaction-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    delete process.env.BRIDGE_LEGACY_MEMORY_COMPACTION_ENABLED;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  it("parses a provider-only chain, maps agy, and excludes unsupported providers", () => {
    expect(parseCompactionProviderChain(" codex, agy, unsupported, invalid, claude, codex ")).toEqual([
      { provider: "codex", model: null },
      { provider: "antigravity", model: null },
      { provider: "claude", model: null },
    ]);
  });

  it("validates and deduplicates ordered provider:model targets", () => {
    expect(parseCompactionProviderChain(
      "claude:claude-sonnet-5,claude:claude-sonnet-5,codex:gpt-5.6-sol,claude:bad model,unsupported:any",
    )).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
  });

  it("selects the incoming healthy provider before the configured chain", () => {
    expect(selectCapacityFallbackCompactionTarget({
      toCli: "claude",
      exhaustedClis: ["codex"],
      configuredChain: [
        { provider: "antigravity", model: null },
        { provider: "claude", model: "claude-sonnet-5" },
      ],
    })).toEqual({ provider: "claude", model: null });
  });

  it("uses the configured chain when the incoming provider cannot compact tool-free", () => {
    expect(selectCapacityFallbackCompactionTarget({
      toCli: "claude",
      exhaustedClis: ["codex", "claude"],
      configuredChain: [
        { provider: "codex", model: null },
        { provider: "antigravity", model: "gemini-high" },
        { provider: "claude", model: null },
      ],
    })).toEqual({ provider: "antigravity", model: "gemini-high" });
  });

  it("never selects a provider already marked capacity-exhausted", () => {
    expect(selectCapacityFallbackCompactionTarget({
      toCli: "claude",
      exhaustedClis: ["codex", "claude"],
      configuredChain: [
        { provider: "codex", model: null },
        { provider: "claude", model: null },
        { provider: "antigravity", model: null },
      ],
    })).toEqual({ provider: "antigravity", model: null });
  });

  it("compacts database-owned turns with the incoming provider, never the exhausted provider", async () => {
    db.addConvTurn("chat:1", "user", "preserve this context");
    const runCli = vi.fn().mockImplementation(async (command: string) => {
      if (command === "codex") throw new Error("exhausted Codex must not be called");
      return JSON.stringify({ result: compactJson("Current objective:\n- preserve context") });
    });

    const result = await runCapacityFallbackCompaction({
      chatKey: "chat:1",
      fromCli: "codex",
      toCli: "claude",
      exhaustedClis: ["codex"],
    }, {
      db,
      runCli,
      bots: {
        codex: { command: "codex", modelPreference: ["gpt-5.6-sol"] },
        claude: { command: "claude", modelPreference: ["claude-fable-5"] },
      },
      configuredChain: [
        { provider: "codex", model: null },
        { provider: "claude", model: null },
      ],
      compactProfile: "companion",
    });

    expect(result.outcome).toBe("compacted");
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][0]).toBe("claude");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?").get("chat:1"))
      .toEqual({ count: 1 });
  });

  it("fails non-destructively without spawning when no healthy tool-free target exists", async () => {
    db.addConvTurn("chat:1", "user", "do not delete me");
    const runCli = vi.fn();

    const result = await runCapacityFallbackCompaction({
      chatKey: "chat:1",
      fromCli: "codex",
      toCli: "claude",
      exhaustedClis: ["codex", "claude", "antigravity"],
    }, {
      db,
      runCli,
      bots: {},
      configuredChain: [
        { provider: "codex", model: null },
        { provider: "claude", model: null },
        { provider: "antigravity", model: null },
      ],
      compactProfile: "companion",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      trigger: "capacity_fallback",
      error: "No healthy tool-free compaction provider is available",
    });
    expect(runCli).not.toHaveBeenCalled();
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    expect(db.getLatestCompactionAttempt("chat:1")).toEqual(expect.objectContaining({
      trigger: "capacity_fallback",
      provider: "unavailable",
      model: null,
      outcome: "failed",
      error_category: "provider_unavailable",
      chunk_count: 0,
      cli_call_count: 0,
      range_start_turn_id: null,
      range_end_turn_id: null,
    }));
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?").get("chat:1"))
      .toEqual({ count: 1 });
  });

  it("records one bounded preflight failure without spawning when the selected provider has no bot config", async () => {
    db.addConvTurn("chat:1", "user", "keep this private turn");
    const runCli = vi.fn();

    const result = await runCapacityFallbackCompaction({
      chatKey: "chat:1",
      fromCli: "codex",
      toCli: "claude",
      exhaustedClis: ["codex"],
    }, {
      db,
      runCli,
      bots: {},
      configuredChain: [{ provider: "claude", model: null }],
      compactProfile: "companion",
    });

    expect(result).toMatchObject({ outcome: "failed", trigger: "capacity_fallback" });
    expect(runCli).not.toHaveBeenCalled();
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    expect(db.getLatestCompactionAttempt("chat:1")).toEqual(expect.objectContaining({
      trigger: "capacity_fallback",
      provider: "claude",
      model: null,
      outcome: "failed",
      error_category: "provider_unavailable",
      chunk_count: 0,
      cli_call_count: 0,
      range_start_turn_id: null,
      range_end_turn_id: null,
    }));
    expect(JSON.stringify(db.getLatestCompactionAttempt("chat:1"))).not.toContain("keep this private turn");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?").get("chat:1"))
      .toEqual({ count: 1 });
  });

  it("keeps a preflight failure non-blocking and secret-safe when telemetry persistence fails", async () => {
    const runCli = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(db, "addCompactionAttempt").mockImplementation(() => {
      throw new Error("raw token=must-not-leak");
    });

    const result = await runCapacityFallbackCompaction({
      chatKey: "chat:1",
      fromCli: "codex",
      toCli: "claude",
      exhaustedClis: ["codex", "claude", "antigravity"],
    }, {
      db,
      runCli,
      bots: {},
      configuredChain: [],
      compactProfile: "companion",
    });

    expect(result).toMatchObject({ outcome: "failed", trigger: "capacity_fallback" });
    expect(runCli).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[compaction-telemetry] write failed for capacity_fallback/failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-leak");
    warn.mockRestore();
  });
});
