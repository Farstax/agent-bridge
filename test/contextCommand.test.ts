import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import type { BridgeDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

describe("agent-bridge-context helper", () => {
  function makeDb() {
    const path = join(tmpdir(), `agent-bridge-context-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    return { db, path };
  }

  it("renders the latest summary for the scoped chat key", () => {
    const { db, path } = makeDb();
    try {
      db.addConvTurn("chat:1", "user", "older turn", "codex");
      db.addConvSummary("chat:1", 1, 1, "Current objective:\n- Keep continuity.");

      const output = renderAgentBridgeContext(["--summary"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).toContain("Current objective:");
      expect(output).toContain("Keep continuity");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("renders recent turns with a limit", () => {
    const { db, path } = makeDb();
    try {
      db.addConvTurn("chat:1", "user", "first", "codex");
      db.addConvTurn("chat:1", "assistant", "second", "codex");
      db.addConvTurn("chat:1", "user", "third", "codex");

      const output = renderAgentBridgeContext(["--recent", "2"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).not.toContain("first");
      expect(output).toContain("Assistant: second");
      expect(output).toContain("User: third");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("requires context env vars", () => {
    expect(() => renderAgentBridgeContext(["--summary"], {})).toThrow(/AGENT_BRIDGE_CONTEXT_DB/);
    expect(() => renderAgentBridgeContext(["--summary"], { AGENT_BRIDGE_CONTEXT_DB: "x" })).toThrow(/AGENT_BRIDGE_CHAT_KEY/);
  });

  it("--memory flag returns memories matching conversation context", () => {
    const { db, path } = makeDb();
    try {
      db.addMemory({ id: "mem_ctx1", type: "decision", scope: "project", text: "fallback CLI persists after successful switch" });
      db.addConvTurn("chat:1", "user", "the fallback keeps resetting to claude", "codex");

      const output = renderAgentBridgeContext(["--memory"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).toContain("fallback");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("--memory-query flag returns memories for explicit query", () => {
    const { db, path } = makeDb();
    try {
      db.addMemory({ id: "mem_ctx2", type: "decision", scope: "project", text: "chunked map-reduce compaction handles large histories" });

      const output = renderAgentBridgeContext(["--memory-query", "compact summaries"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).toContain("compaction");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("--memory-query excludes chat-scoped memories from other chats", () => {
    const { db, path } = makeDb();
    try {
      db.addMemory({
        id: "mem_ctx_private",
        type: "decision",
        scope: "chat",
        source_chat_key: "chat:private",
        text: "private chat scoped deploy preference",
      });
      db.addMemory({
        id: "mem_ctx_project",
        type: "decision",
        scope: "project",
        source_chat_key: "chat:other",
        text: "project scoped deploy preference",
      });

      const output = renderAgentBridgeContext(["--memory-query", "deploy preference"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:public",
      });

      expect(output).not.toContain("private chat scoped");
      expect(output).toContain("project scoped deploy preference");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("--memory flag returns empty message when no memories exist", () => {
    const { db, path } = makeDb();
    try {
      const output = renderAgentBridgeContext(["--memory"], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      });

      expect(output).toContain("No project memories");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("--memory-add-json stores a valid project memory for the current chat", () => {
    const { db, path } = makeDb();
    try {
      const output = renderAgentBridgeContext([
        "--memory-add-json",
        JSON.stringify({
          type: "decision",
          scope: "project",
          text: "Agent-driven memory writes use validated JSON candidates.",
          confidence: 0.8,
        }),
      ], {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
        AGENT_BRIDGE_CLI_KIND: "codex",
      });

      expect(output).toContain("Memory stored");
      expect(db.searchMemories("validated JSON candidates").at(0)?.text).toContain("Agent-driven memory writes");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("--memory-add-json rejects duplicates and secret-looking text", () => {
    const { db, path } = makeDb();
    try {
      const env = {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
        AGENT_BRIDGE_CLI_KIND: "codex",
      };
      const candidate = JSON.stringify({
        type: "decision",
        scope: "project",
        text: "Duplicate durable memory candidate.",
      });

      expect(renderAgentBridgeContext(["--memory-add-json", candidate], env)).toContain("Memory stored");
      expect(renderAgentBridgeContext(["--memory-add-json", candidate], env)).toContain("duplicate");
      expect(db.getMemoryCount()).toBe(1);

      const rejected = renderAgentBridgeContext([
        "--memory-add-json",
        JSON.stringify({ type: "decision", scope: "project", text: "API_KEY=abc123 should not be stored" }),
      ], env);
      expect(rejected).toContain("rejected");
      expect(db.getMemoryCount()).toBe(1);
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  it("stops surfacing a blocker once a later entry resolves it (issue #304)", () => {
    const { db, path } = makeDb();
    try {
      const env = {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
        AGENT_BRIDGE_CLI_KIND: "codex",
      };

      db.addMemory({
        id: "mem_bridge_arubablocker",
        type: "decision",
        scope: "project",
        text: "blocked pending independent verification of the Aruba SSH host key",
      });

      const beforeResolution = renderAgentBridgeContext(["--memory-query", "Aruba SSH host key"], env);
      expect(beforeResolution).toContain("blocked pending independent verification");

      const resolveOutput = renderAgentBridgeContext([
        "--memory-add-json",
        JSON.stringify({
          type: "decision",
          scope: "project",
          text: "Aruba SSH host key trust anchor committed; guard script merged and a guarded production deployment succeeded.",
          resolves: ["mem_bridge_arubablocker"],
        }),
      ], env);
      expect(resolveOutput).toContain("Memory stored");

      const afterResolution = renderAgentBridgeContext(["--memory-query", "Aruba SSH host key"], env);
      expect(afterResolution).not.toContain("blocked pending independent verification");
      expect(afterResolution).toContain("trust anchor committed");
    } finally {
      db.close();
      rmSync(path, { force: true });
    }
  });

  describe("--search flag (issue #350)", () => {
    it("finds an older turn by scoped chronological search", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "we decided to use minimax for summarisation", "codex");
        for (let i = 0; i < 10; i++) db.addConvTurn("chat:1", "user", `filler turn ${i}`, "codex");

        const output = renderAgentBridgeContext(["--search", "minimax"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output).toContain("minimax");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("cannot cross chat scope", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "codename falcon lives here", "codex");
        db.addConvTurn("chat:2", "user", "codename falcon lives elsewhere", "codex");

        const output = renderAgentBridgeContext(["--search", "codename falcon"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output).toContain("lives here");
        expect(output).not.toContain("lives elsewhere");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("returns a safe bounded message for an empty query", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "some turn", "codex");
        const output = renderAgentBridgeContext(["--search", ""], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });
        expect(output).toBe("No conversation turns found for that query.");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("returns a safe bounded message for a no-match query", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "hello world", "codex");
        const output = renderAgentBridgeContext(["--search", "zzz-nonexistent-zzz"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });
        expect(output).toBe("No conversation turns found matching that query.");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("surfaces matching evidence in chronology, usable as handoff evidence", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "the release date is March 1st", "claude");
        db.addConvTurn("chat:1", "assistant", "correction: the release date is March 15th", "claude");

        const output = renderAgentBridgeContext(["--search", "release date"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        const marchFifteenIdx = output.indexOf("March 15th");
        const marchFirstIdx = output.indexOf("March 1st");
        expect(marchFifteenIdx).toBeGreaterThanOrEqual(0);
        expect(marchFirstIdx).toBeGreaterThanOrEqual(0);
        expect(marchFirstIdx).toBeLessThan(marchFifteenIdx);
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("keeps the complete rendered search output bounded for an oversized query", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "needle is the useful search term", "codex");
        const oversizedQuery = `needle\n${"x".repeat(10_000)}`;

        const output = renderAgentBridgeContext(["--search", oversizedQuery], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output.length).toBeLessThanOrEqual(4_000);
        expect(output).not.toContain("\n" + "x".repeat(100));
        expect(output).toContain("needle");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });
  });
});
