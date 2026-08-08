import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb, type BridgeDb } from "../src/db.js";
import { compactConversation } from "../src/compactConversation.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

function compactJson(summaryMd: string, memoryCandidates: unknown[] = []): string {
  return JSON.stringify({ summary_md: summaryMd, memory_candidates: memoryCandidates });
}

describe("companion automatic memory scope", () => {
  let dbPath: string;
  let db: BridgeDb;

  beforeEach(() => {
    dbPath = join(tmpdir(), `companion-memory-scope-${Date.now()}-${Math.random()}.sqlite`);
    db = openDb(dbPath);
  });

  afterEach(() => {
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
    compactProfile: "companion" as const,
  });

  const queryMemory = (chatKey: string, query: string): string => renderAgentBridgeContext(
    ["--memory-query", query],
    {
      AGENT_BRIDGE_CONTEXT_DB: dbPath,
      AGENT_BRIDGE_CHAT_KEY: chatKey,
      AGENT_BRIDGE_CLI_KIND: "claude",
      AGENT_BRIDGE_REPO_PATH: process.cwd(),
    },
  );

  it("defaults an unscoped companion compaction memory to chat scope", async () => {
    db.addConvTurn("group:topic", "user", "Keep the launch rehearsal detail in this conversation.");
    const text = "Friday launch rehearsal uses the staging checklist.";
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- launch rehearsal", [
      { type: "note", text, confidence: 0.8 },
    ]));

    const result = await compactConversation("group:topic", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(queryMemory("group:topic", "launch rehearsal staging checklist")).toContain(text);
    expect(queryMemory("dm:owner", "launch rehearsal staging checklist")).not.toContain(text);
    const stored = db.raw.prepare("SELECT scope FROM project_memories WHERE text = ?").get(text) as { scope: string };
    expect(stored.scope).toBe("chat");
  });

  it("preserves explicitly classified project memory across chats", async () => {
    db.addConvTurn("group:topic", "user", "Record the durable project decision.");
    const text = "Interactive Telegram conversations use per-chat execution lanes.";
    const runCli = vi.fn().mockResolvedValue(compactJson("Current objective:\n- preserve architecture", [
      { type: "decision", scope: "project", text, confidence: 0.95 },
    ]));

    const result = await compactConversation("group:topic", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(queryMemory("dm:owner", "interactive telegram execution lanes")).toContain(text);
    const stored = db.raw.prepare("SELECT scope FROM project_memories WHERE text = ?").get(text) as { scope: string };
    expect(stored.scope).toBe("project");
  });

  it("tells companion compaction to reserve project scope for durable project knowledge and use chat when uncertain", async () => {
    db.addConvTurn("group:topic", "user", "Summarise this conversation safely.");
    let capturedPrompt = "";
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      capturedPrompt = args[args.length - 1];
      return compactJson("Current objective:\n- safe memory classification");
    });

    const result = await compactConversation("group:topic", deps(runCli));

    expect(result.outcome).toBe("compacted");
    expect(capturedPrompt).toContain("Use project scope only for durable project knowledge");
    expect(capturedPrompt).toContain("When scope is uncertain, use chat");
  });
});
