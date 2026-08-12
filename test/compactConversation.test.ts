import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { compactConversation } from "../src/compactConversation.js";
import { buildExecutionOptions } from "../src/cli.js";

function compactJson(summaryMd: string, memoryCandidates: unknown[] = []): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: memoryCandidates });
}

describe("compactConversation", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `compact-conversation-test-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  const deps = (runCli: (...args: any[]) => Promise<string>) => ({
    db,
    runCli,
    botConfig: { command: "claude", modelPreference: ["claude-opus-4-5"] },
    cliKind: "claude",
    trigger: "manual" as const,
  });

  it("clears the compact timeout after a fast provider result", async () => {
    vi.useFakeTimers();
    db.addConvTurn("chat:1", "user", "compact without leaking a timer");
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- no timer leak"));

    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["manual", "preseed", "capacity_fallback"] as const)(
    "records a bounded no_turns attempt for the %s trigger",
    async (trigger) => {
      db.setSetting("claude", "claude-fable-5");
      const runCli = vi.fn();
      const result = await compactConversation("chat:1", {
        ...deps(runCli),
        trigger,
        now: () => new Date("2026-07-13T10:00:00.000Z"),
      });

      expect(result.outcome).toBe("no_turns");
      expect(db.getLatestCompactionAttempt("chat:1")).toEqual(expect.objectContaining({
        trigger,
        provider: "claude",
        model: "claude-fable-5",
        outcome: "no_turns",
        error_category: null,
        duration_ms: 0,
        chunk_count: 0,
        cli_call_count: 0,
        range_start_turn_id: null,
        range_end_turn_id: null,
        started_at: "2026-07-13T10:00:00.000Z",
        ended_at: "2026-07-13T10:00:00.000Z",
      }));
    },
  );

  it("records provider, model, timing, calls, chunks and covered turn range on success", async () => {
    process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS = "80";
    try {
      for (let i = 0; i < 4; i++) {
        db.addConvTurn("chat:1", i % 2 === 0 ? "user" : "assistant", `turn-${i} ${"x".repeat(40)}`);
      }
      db.setSetting("claude", "claude-sonnet-5");
      const times = [
        new Date("2026-07-13T10:00:00.000Z"),
        new Date("2026-07-13T10:00:00.125Z"),
      ];
      const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- telemetry"));

      const result = await compactConversation("chat:1", {
        ...deps(runCli),
        trigger: "preseed",
        now: () => times.shift()!,
      });

      expect(result.outcome).toBe("compacted");
      const attempt = db.getLatestCompactionAttempt("chat:1");
      expect(attempt).toEqual(expect.objectContaining({
        trigger: "preseed",
        provider: "claude",
        model: "claude-sonnet-5",
        outcome: "compacted",
        error_category: null,
        duration_ms: 125,
        chunk_count: 4,
        cli_call_count: 5,
        range_start_turn_id: 1,
        range_end_turn_id: 4,
      }));
      expect(runCli).toHaveBeenCalledTimes(5);
    } finally {
      delete process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS;
    }
  });

  it("stores only a bounded failure category and never persists sensitive compaction material", async () => {
    const secret = "token=super-secret raw repository conversation";
    db.addConvTurn("chat:1", "user", secret);
    const runCli = vi.fn().mockResolvedValue(`invalid output ${secret}`);

    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      trigger: "capacity_fallback",
    });

    expect(result.outcome).toBe("failed");
    const attempt = db.getLatestCompactionAttempt("chat:1");
    expect(attempt).toEqual(expect.objectContaining({
      trigger: "capacity_fallback",
      outcome: "failed",
      error_category: "invalid_output",
      cli_call_count: 2,
      chunk_count: 1,
      range_start_turn_id: 1,
      range_end_turn_id: 1,
    }));
    expect(JSON.stringify(attempt)).not.toContain(secret);
    const columns = db.raw.prepare("PRAGMA table_info(compaction_attempts)").all()
      .map((column: any) => column.name);
    expect(columns).not.toEqual(expect.arrayContaining([
      "prompt", "raw_output", "summary", "memory_candidates", "conversation_text", "error_message",
    ]));
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
  });

  it("does not alter a successful compaction result when telemetry persistence fails", async () => {
    db.addConvTurn("chat:1", "user", "compact safely");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(db, "addCompactionAttempt").mockImplementation(() => {
      throw new Error("telemetry database contains token=must-not-leak");
    });
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- compact safely"));

    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(db.getLatestConvSummary("chat:1")?.summary_md).toContain("compact safely");
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith("[compaction-telemetry] write failed for manual/compacted");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-leak");
    warn.mockRestore();
  });

  it("uses Codex JSON events, tool-free flags, and normal execution options", async () => {
    db.addConvTurn("chat:1", "user", "fix the Codex contract");
    const output = compactJson("Current objective:\n- fix Codex contract");
    const runCli = vi.fn().mockResolvedValue([
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: output } }),
    ].join("\n"));

    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      botConfig: { command: "codex", modelPreference: ["gpt-5.6-sol"] },
      cliKind: "codex",
    });

    expect(result.outcome).toBe("compacted");
    const [, args, , options] = runCli.mock.calls[0];
    expect(args).toContain("--json");
    expect(args).toEqual(expect.arrayContaining(["--disable", "shell_tool", "--disable", "plugins"]));
    expect(options).toEqual(buildExecutionOptions("codex"));
  });

  it("keeps Claude JSON extraction compatible and runs tool-free", async () => {
    db.addConvTurn("chat:1", "user", "fix the Claude contract");
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      result: compactJson("Current objective:\n- fix Claude contract"),
      session_id: "claude-session",
    }));

    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    const [, args, , options] = runCli.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining([
      "--output-format", "json", "--tools", "", "--disable-slash-commands", "--strict-mcp-config",
    ]));
    expect(options).toEqual(buildExecutionOptions("claude"));
  });

  it("keeps Agy wrapped extraction compatible and runs tool-free", async () => {
    db.addConvTurn("chat:1", "user", "fix the Agy contract");
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      reasoning: "bounded transformation",
      response: compactJson("Current objective:\n- fix Agy contract"),
    }));

    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      botConfig: { command: "agy", modelPreference: ["gemini-3.5-flash-high"] },
      cliKind: "antigravity",
      trigger: "manual",
    });

    expect(result.outcome).toBe("compacted");
    const [, args, , options] = runCli.mock.calls[0];
    expect(args).toContain("--sandbox");
    expect(options).toEqual(buildExecutionOptions("antigravity"));
  });

  it("fails closed without spawning or mutating state when Kimchi lacks verified tool-free execution", async () => {
    db.addConvTurn("chat:1", "user", "keep this turn intact");
    const runCli = vi.fn().mockResolvedValue(compactJson("must not be used"));

    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      botConfig: { command: "kimchi", modelPreference: ["default"] },
      cliKind: "kimchi",
    });

    expect(result).toMatchObject({
      outcome: "failed",
      trigger: "manual",
      error: "Kimchi compaction is disabled because verified tool-free execution is not supported",
    });
    expect(runCli).not.toHaveBeenCalled();
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
  });

  it("returns no_turns when there is nothing to compact", async () => {
    const runCli = vi.fn().mockResolvedValue(compactJson("should not be called"));
    const result = await compactConversation("chat:1", deps(runCli));
    expect(result.outcome).toBe("no_turns");
    expect(runCli).not.toHaveBeenCalled();
  });

  it("stores the summary and retains source turns as recoverable evidence on success (issue #349)", async () => {
    db.addConvTurn("chat:1", "user", "fix the bug");
    db.addConvTurn("chat:1", "assistant", "fixed");

    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- fix bug"));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(result.summaryMd).toBe("Current objective:\n- fix bug");
    expect(result.turnCount).toBe(2);

    const summary = db.getLatestConvSummary("chat:1");
    expect(summary?.summary_md).toBe("Current objective:\n- fix bug");

    // The summary must not become the only surviving copy of the source
    // turns: they remain in conversation_turns as recoverable evidence.
    const raw = (db as any).raw as import("better-sqlite3").Database;
    const retained = raw
      .prepare(`SELECT text FROM conversation_turns WHERE chat_key = ? ORDER BY id`)
      .all("chat:1") as Array<{ text: string }>;
    expect(retained).toEqual([{ text: "fix the bug" }, { text: "fixed" }]);

    // Bounded context/backlog construction stays bounded by the new
    // summary's range_end_turn_id, exactly as before this change.
    expect(db.getRecentConvTurns("chat:1", 100)).toEqual([]);
    expect(db.getConvTurnsForCompaction("chat:1")).toEqual([]);
  });

  it("promotes valid memory candidates and counts rejected ones separately", async () => {
    db.addConvTurn("chat:1", "user", "remember this decision");

    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- noted", [
      { type: "decision", scope: "project", text: "Use compact-first memory architecture.", confidence: 0.9 },
      { type: "not-a-real-type", scope: "project", text: "invalid type candidate" },
    ]));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(result.promotedMemoryIds).toHaveLength(1);
    expect(result.rejectedCandidateCount).toBe(1);
    expect(db.searchMemories("compact-first memory architecture").length).toBeGreaterThan(0);
  });

  it("rolls back summary and promoted memory when memory promotion fails", async () => {
    db.addConvTurn("chat:1", "user", "remember this decision atomically");
    const originalAddMemory = db.addMemory.bind(db);
    vi.spyOn(db, "addMemory").mockImplementation((memory) => {
      originalAddMemory(memory);
      throw new Error("promotion failure token=must-not-leak");
    });
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- atomic memory", [
      { type: "decision", scope: "project", text: "Commit compacted memory atomically.", confidence: 0.9 },
    ]));

    const result = await compactConversation("chat:1", deps(runCli));

    expect(result).toMatchObject({
      outcome: "failed",
      error: "Compaction failed (unknown)",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    expect(db.getLatestCompactionAttempt("chat:1")).toMatchObject({
      outcome: "failed",
      error_category: "unknown",
    });
  });

  it("leaves the existing summary and retained turns unchanged when the commit fence rejects (issue #349)", async () => {
    // Regression for issue #349: an interrupted/failed compaction must leave
    // both the prior summary and the source-turn evidence untouched. Since
    // compaction no longer prunes turns as part of its transaction, this
    // exercises rollback via the execution-lane commit fence instead of a
    // failing prune call.
    db.addConvTurn("chat:1", "user", "keep this turn if the commit fails");
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- atomic pruning", [
      { type: "decision", scope: "project", text: "Rollback every compaction mutation together.", confidence: 0.9 },
    ]));

    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      assertCanCommit: () => {
        throw new Error("commit fence rejected repository=private-content");
      },
    });

    expect(result).toMatchObject({
      outcome: "failed",
      error: "Compaction failed (unknown)",
    });
    expect(JSON.stringify(result)).not.toContain("private-content");
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    expect(db.getLatestCompactionAttempt("chat:1")).toMatchObject({
      outcome: "failed",
      error_category: "unknown",
    });
  });

  it("does not store a summary or prune turns when the CLI call fails", async () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "hi");

    const runCli = vi.fn().mockRejectedValue(new Error("CLI timeout"));
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(2);
  });

  it("does not store partial summary, promote chunk memory, or prune turns when reduce fails", async () => {
    process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS = "80";
    try {
      for (let i = 0; i < 4; i++) {
        db.addConvTurn("chat:1", i % 2 === 0 ? "user" : "assistant", `turn-${i} ${"x".repeat(40)}`);
      }
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Merge these compact summaries") || prompt.includes("invalid reduce output")) {
          return "invalid reduce output";
        }
        return compactJson("Current objective:\n- partial chunk", [
          { type: "decision", scope: "project", text: "Partial output must never become memory.", confidence: 0.9 },
        ]);
      });

      const result = await compactConversation("chat:1", deps(runCli));

      expect(result.outcome).toBe("failed");
      expect(db.getLatestConvSummary("chat:1")).toBeNull();
      expect(db.getMemoryCount()).toBe(0);
      expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(4);
      expect(result.trigger).toBe("manual");
    } finally {
      delete process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS;
    }
  });

  it("does not store a summary or prune turns when the CLI returns non-JSON/invalid output", async () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "hi");

    const runCli = vi.fn().mockResolvedValue("Sure, here is a prose summary with no JSON structure.");
    const result = await compactConversation("chat:1", deps(runCli));

    expect(result.outcome).toBe("failed");
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(2);
  });

  it("merges chunked summaries with a previous summary via the reduce path", async () => {
    process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS = "80";
    try {
      for (let i = 0; i < 6; i++) {
        db.addConvTurn("chat:1", i % 2 === 0 ? "user" : "assistant", `turn-${i} ${"x".repeat(40)}`);
      }
      const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
        const prompt = args[args.length - 1];
        if (prompt.includes("Merge these compact summaries")) {
          return compactJson("Current objective:\n- merged all chunks");
        }
        return compactJson("Current objective:\n- chunk summary");
      });
      const result = await compactConversation("chat:1", deps(runCli));

      expect(result.outcome).toBe("compacted");
      expect(result.summaryMd).toBe("Current objective:\n- merged all chunks");
      expect(runCli.mock.calls.length).toBeGreaterThan(1);
    } finally {
      delete process.env.BRIDGE_COMPACT_CHUNK_MAX_CHARS;
    }
  });

  it("honors the companion compact profile in the prompt sent to the CLI", async () => {
    db.addConvTurn("chat:1", "user", "remind me about my training plan");

    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return compactJson("Current objective:\n- track training");
    });
    const result = await compactConversation("chat:1", {
      ...deps(runCli),
      compactProfile: "companion",
    });

    expect(result.outcome).toBe("compacted");
    expect(capturedPrompt).toContain("preferences");
  });

  it("succeeds when antigravity wrapped output has valid compact JSON", async () => {
    db.addConvTurn("chat:1", "user", "fix the bug");
    db.addConvTurn("chat:1", "assistant", "fixed");

    const innerJson = compactJson("Current objective:\n- antigravity fixed bug");
    const rawOutput = JSON.stringify({
      reasoning: "thinking about the turns",
      response: innerJson,
    });

    const runCli = vi.fn().mockResolvedValue(rawOutput);
    const result = await compactConversation("chat:1", {
      db,
      runCli,
      botConfig: { command: "agy", modelPreference: ["gemini-3.5-flash-high"] },
      cliKind: "antigravity",
      trigger: "manual",
    });

    expect(result.outcome).toBe("compacted");
    expect(result.summaryMd).toBe("Current objective:\n- antigravity fixed bug");
    expect(result.turnCount).toBe(2);

    const summary = db.getLatestConvSummary("chat:1");
    expect(summary?.summary_md).toBe("Current objective:\n- antigravity fixed bug");
    expect(db.getRecentConvTurns("chat:1", 100)).toEqual([]);
  });

  it("fails safely without pruning turns when antigravity wrapped output response has invalid compact JSON", async () => {
    db.addConvTurn("chat:1", "user", "hello");
    db.addConvTurn("chat:1", "assistant", "hi");

    const rawOutput = JSON.stringify({
      reasoning: "bad output",
      response: "not compact json at all",
    });

    const runCli = vi.fn().mockResolvedValue(rawOutput);
    const result = await compactConversation("chat:1", {
      db,
      runCli,
      botConfig: { command: "agy", modelPreference: ["gemini-3.5-flash-high"] },
      cliKind: "antigravity",
      trigger: "manual",
    });

    expect(result.outcome).toBe("failed");
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(2);
  });
});
