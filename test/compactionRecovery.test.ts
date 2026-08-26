import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import {
  compactConversation,
  compactMaxAttempts,
  compactRepairAttempts,
} from "../src/compactConversation.js";

function compactJson(summaryMd: string): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: [] });
}

function codexEvents(text: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  ].join("\n");
}

describe("structured compaction recovery", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `compaction-recovery-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
    db.addConvTurn("chat:1", "user", "PRIVATE_CONVERSATION_SECRET");
  });

  afterEach(() => {
    delete process.env.BRIDGE_COMPACTION_MAX_ATTEMPTS;
    delete process.env.BRIDGE_COMPACTION_REPAIR_ATTEMPTS;
    db.close();
    try { rmSync(dbPath); } catch {}
  });

  const baseDeps = (runCli: (...args: any[]) => Promise<string>) => ({
    db,
    runCli,
    botConfig: { command: "claude", modelPreference: ["claude-primary"] },
    cliKind: "claude",
    trigger: "manual" as const,
  });

  it("keeps clean JSON on the normal one-call path", async () => {
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      result: compactJson("Current objective:\n- clean"),
      session_id: "session",
    }));

    const result = await compactConversation("chat:1", baseDeps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it("allows exactly one successful repair using only invalid output and schema instructions", async () => {
    let repairPrompt = "";
    const runCli = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ result: "BROKEN_STRUCTURED_RESPONSE" }))
      .mockImplementationOnce(async (_command: string, args: string[]) => {
        repairPrompt = args[args.length - 1];
        return JSON.stringify({ result: compactJson("Current objective:\n- repaired") });
      });

    const result = await compactConversation("chat:1", baseDeps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(repairPrompt).toContain("BROKEN_STRUCTURED_RESPONSE");
    expect(repairPrompt).toContain("summary_md");
    expect(repairPrompt).not.toContain("PRIVATE_CONVERSATION_SECRET");
    expect(db.getLatestCompactionAttempt("chat:1")?.cli_call_count).toBe(2);
  });

  it("never performs a second repair", async () => {
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({ result: "still invalid" }));

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      maxAttempts: 1,
    });

    expect(result.outcome).toBe("failed");
    expect(runCli).toHaveBeenCalledTimes(2);
  });

  it("shares the one-repair budget across provider/model fallback targets", async () => {
    const commands: string[] = [];
    const runCli = vi.fn().mockImplementation(async (command: string) => {
      commands.push(command);
      if (command === "codex") return codexEvents("invalid fallback output");
      return JSON.stringify({ result: "invalid primary output" });
    });

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      fallbackTargets: [{ provider: "codex", command: "codex", model: "gpt-fallback" }],
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("failed");
    expect(commands).toEqual(["claude", "claude", "codex"]);
    expect(db.getLatestCompactionAttempt("chat:1")?.cli_call_count).toBe(3);
  });

  it("falls back in order and records one logical row with aggregate calls and final target", async () => {
    const commands: string[] = [];
    const runCli = vi.fn().mockImplementation(async (command: string) => {
      commands.push(command);
      if (command === "claude") throw new Error("Authentication required: please log in token=PRIVATE");
      return codexEvents(compactJson("Current objective:\n- fallback succeeded"));
    });

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      fallbackTargets: [
        { provider: "codex", command: "codex", model: "gpt-fallback" },
        { provider: "antigravity", command: "agy", model: "gemini-last" },
      ],
      maxAttempts: 3,
    });

    expect(result.outcome).toBe("compacted");
    expect(commands).toEqual(["claude", "codex"]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?")
      .get("chat:1")).toEqual({ count: 1 });
    expect(db.getLatestCompactionAttempt("chat:1")).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-fallback",
      outcome: "compacted",
      error_category: null,
      cli_call_count: 2,
      chunk_count: 1,
    }));
  });

  it("excludes exhausted providers and enforces the provider/model attempt cap", async () => {
    const commands: string[] = [];
    const runCli = vi.fn().mockImplementation(async (command: string) => {
      commands.push(command);
      throw new Error("service unavailable");
    });

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      fallbackTargets: [
        { provider: "codex", command: "codex", model: "gpt-exhausted" },
        { provider: "antigravity", command: "agy", model: "gemini-eligible" },
        { provider: "claude", command: "claude", model: "claude-last" },
      ],
      exhaustedProviders: ["codex"],
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("failed");
    expect(commands).toEqual(["claude", "agy"]);
  });

  it.each([
    new DOMException("cancelled by user", "AbortError"),
    new Error("command not found: broken-compactor"),
  ])("does not fall back after cancellation or fatal failure", async (failure) => {
    const runCli = vi.fn().mockRejectedValue(failure);

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      fallbackTargets: [{ provider: "codex", command: "codex", model: "must-not-run" }],
    });

    expect(result.outcome).toBe("failed");
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it("keeps all-target invalid/transient failure non-destructive and secret-safe", async () => {
    const rawSecret = "raw-output-token=SHOULD_NOT_PERSIST";
    const runCli = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ result: rawSecret }))
      .mockResolvedValueOnce(JSON.stringify({ result: rawSecret }))
      .mockRejectedValueOnce(new Error(`ECONNRESET ${rawSecret}`));

    const result = await compactConversation("chat:1", {
      ...baseDeps(runCli),
      fallbackTargets: [{ provider: "codex", command: "codex", model: "gpt-final" }],
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).not.toContain(rawSecret);
    expect(runCli).toHaveBeenCalledTimes(3);
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    const attempt = db.getLatestCompactionAttempt("chat:1");
    expect(attempt).toEqual(expect.objectContaining({
      provider: "codex",
      model: "gpt-final",
      outcome: "failed",
      error_category: "transient",
      cli_call_count: 3,
    }));
    expect(JSON.stringify(attempt)).not.toContain(rawSecret);
  });

  it("fails safely on retired empty Agy output without restoring a legacy repair path", async () => {
    const rawSecret = "agy-fallback-token=DO_NOT_PERSIST";
    const commands: string[] = [];
    const runCli = vi.fn().mockImplementation(async (command: string) => {
      commands.push(command);
      if (command === "agy") return "";
      throw new Error(`ECONNRESET ${rawSecret}`);
    });

    const result = await compactConversation("chat:1", {
      db,
      runCli,
      botConfig: { command: "agy", modelPreference: ["gemini-primary"] },
      cliKind: "antigravity",
      trigger: "manual",
      fallbackTargets: [{ provider: "codex", command: "codex", model: "gpt-fallback" }],
      maxAttempts: 2,
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).not.toContain(rawSecret);
    expect(commands).toEqual(["agy"]);
    expect(db.getLatestConvSummary("chat:1")).toBeNull();
    expect(db.getMemoryCount()).toBe(0);
    expect(db.getRecentConvTurns("chat:1", 100)).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM compaction_attempts WHERE chat_key = ?")
      .get("chat:1")).toEqual({ count: 1 });
    const attempt = db.getLatestCompactionAttempt("chat:1");
    expect(attempt).toEqual(expect.objectContaining({
      provider: "antigravity",
      model: "gemini-primary",
      outcome: "failed",
      error_category: "fatal",
      cli_call_count: 1,
    }));
    expect(JSON.stringify(attempt)).not.toContain(rawSecret);
  });

  it("uses bounded safe configuration defaults", () => {
    expect(compactMaxAttempts()).toBe(3);
    expect(compactRepairAttempts()).toBe(1);
    process.env.BRIDGE_COMPACTION_MAX_ATTEMPTS = "999";
    process.env.BRIDGE_COMPACTION_REPAIR_ATTEMPTS = "999";
    expect(compactMaxAttempts()).toBeLessThanOrEqual(8);
    expect(compactRepairAttempts()).toBe(1);
  });
});
