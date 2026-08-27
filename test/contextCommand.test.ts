import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { renderAgentBridgeContext } from "../src/contextCommand.js";

describe("agent-bridge-context helper", () => {
  function makeDb() {
    const path = join(tmpdir(), `agent-bridge-context-${Date.now()}-${Math.random()}.sqlite`);
    const db = openDb(path);
    return { db, path };
  }

  it("renders recent retained turns with a limit", () => {
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
    expect(() => renderAgentBridgeContext([], {})).toThrow(/AGENT_BRIDGE_CONTEXT_DB/);
    expect(() => renderAgentBridgeContext([], { AGENT_BRIDGE_CONTEXT_DB: "x" })).toThrow(/AGENT_BRIDGE_CHAT_KEY/);
  });

  it("does not expose historical generated summaries or project memories", () => {
    const { db, path } = makeDb();
    try {
      db.addConvSummary("chat:1", 1, 1, "retired generated summary marker");
      // Simulates a pre-retirement row left in the schema (#544 is a
      // subtraction-only migration, so no addMemory API remains to write it).
      db.raw
        .prepare(
          `INSERT INTO project_memories (id, scope, type, text) VALUES (?, 'project', 'decision', ?)`
        )
        .run("mem_retired", "retired project memory marker");

      const env = {
        AGENT_BRIDGE_CONTEXT_DB: path,
        AGENT_BRIDGE_CHAT_KEY: "chat:1",
      };
      const summaryOutput = renderAgentBridgeContext(["--summary"], env);
      const memoryOutput = renderAgentBridgeContext(["--memory-query", "retired"], env);

      for (const output of [summaryOutput, memoryOutput]) {
        expect(output).toContain("retained conversation turns only");
        expect(output).toContain("--recent 20");
        expect(output).toContain("--search");
        expect(output).not.toContain("retired generated summary marker");
        expect(output).not.toContain("retired project memory marker");
      }
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

    it("surfaces distinctive evidence for a natural-language query despite newer stopword matches", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "deployment window is Friday at 15:00", "codex");
        for (let i = 0; i < 5; i++) {
          db.addConvTurn("chat:1", "assistant", `what was the status update ${i}`, "codex");
        }

        const output = renderAgentBridgeContext(["--search", "what was the deployment window"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output).toContain("deployment window is Friday at 15:00");
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

    it("preserves every selected match, including the newest correction, when adjacent context exceeds the cap", () => {
      const { db, path } = makeDb();
      try {
        for (let i = 0; i < 5; i++) {
          db.addConvTurn("chat:1", "assistant", `adjacent before ${i} ${"b".repeat(280)}`, "codex");
          db.addConvTurn(
            "chat:1",
            "user",
            `decision ${i}: ${i === 4 ? "NEWEST CORRECTION — deploy Friday at 15:00" : "deploy Thursday at 10:00"} ${"m".repeat(270)}`,
            "codex",
          );
          db.addConvTurn("chat:1", "assistant", `adjacent after ${i} ${"a".repeat(280)}`, "codex");
          db.addConvTurn("chat:1", "assistant", `separator ${i} ${"s".repeat(280)}`, "codex");
        }

        const output = renderAgentBridgeContext(["--search", "decision"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });
        expect(output).toContain("(5, chronological)");
        expect(output.length).toBeLessThanOrEqual(4_000);
        expect(output).toContain("NEWEST CORRECTION — deploy Friday at 15:00");
        for (let i = 0; i < 5; i++) expect(output).toContain(`decision ${i}:`);
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("promotes a matching turn that was first captured as overlapping context", () => {
      const { db, path } = makeDb();
      try {
        const addEvidence = (label: string) => {
          db.addConvTurn("chat:1", "assistant", `context before ${label} ${"b".repeat(280)}`, "codex");
        };
        const addMatch = (label: string) => {
          db.addConvTurn("chat:1", "user", `decision ${label} ${"m".repeat(280)}`, "codex");
        };
        const addTrailing = (label: string) => {
          db.addConvTurn("chat:1", "assistant", `context after ${label} ${"a".repeat(280)}`, "codex");
          db.addConvTurn("chat:1", "assistant", `separator ${label} ${"s".repeat(280)}`, "codex");
        };

        addEvidence("0"); addMatch("0"); addTrailing("0");
        addEvidence("overlap"); addMatch("older"); addMatch("NEWEST CORRECTION"); addTrailing("overlap");
        addEvidence("3"); addMatch("3"); addTrailing("3");
        addEvidence("4"); addMatch("4"); addTrailing("4");

        const output = renderAgentBridgeContext(["--search", "decision"], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output).toContain("(5, chronological)");
        expect(output.length).toBeLessThanOrEqual(4_000);
        expect(output).toContain("decision older");
        expect(output).toContain("decision NEWEST CORRECTION");
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("keeps all three consecutive selected hits marked through overlapping windows", () => {
      const { db, path } = makeDb();
      try {
        const addTurn = (text: string, role: "user" | "assistant" = "assistant") => {
          db.addConvTurn("chat:1", role, text, "codex");
        };
        const filler = (kind: string, label: string) => `${kind} ${label} ${kind[0].repeat(280)}`;

        addTurn(filler("context", "before-0"));
        addTurn(`decision isolated-0 ${"m".repeat(280)}`, "user");
        addTurn(filler("context", "after-0"));
        addTurn(filler("separator", "0"));

        addTurn(filler("context", "before-group"));
        addTurn(`decision A ${"m".repeat(280)}`, "user");
        addTurn(`decision B ${"m".repeat(280)}`, "user");
        addTurn(`decision C NEWEST CORRECTION ${"m".repeat(280)}`, "user");
        addTurn(filler("context", "after-group"));
        addTurn(filler("separator", "group"));

        addTurn(filler("context", "before-4"));
        addTurn(`decision isolated-4 ${"m".repeat(280)}`, "user");
        addTurn(filler("context", "after-4"));
        addTurn(filler("separator", "4"));

        const query = `decision ${"q".repeat(230)}`;
        const output = renderAgentBridgeContext(["--search", query], {
          AGENT_BRIDGE_CONTEXT_DB: path,
          AGENT_BRIDGE_CHAT_KEY: "chat:1",
        });

        expect(output).toContain("decision isolated-0");
        expect(output).toContain("decision A");
        expect(output).toContain("decision B");
        expect(output).toContain("decision C NEWEST CORRECTION");
        expect(output).toContain("decision isolated-4");
        expect(output.length).toBeLessThanOrEqual(4_000);
      } finally {
        db.close();
        rmSync(path, { force: true });
      }
    });

    it("uses conversation scope by default and explicit owner scope for authorized cross-conversation evidence", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "local deployment note", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("chat:2", "assistant", "remote deployment decision Friday", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("chat:3", "assistant", "remote deployment decision Saturday SECRET", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-b" });
        const env = { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "chat:1", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive", AGENT_BRIDGE_OWNER_KEY: "owner-a" };
        const local = renderAgentBridgeContext(["--search", "remote deployment"], env);
        expect(local).not.toContain("Friday");
        const owner = renderAgentBridgeContext(["--search", "remote deployment", "--scope", "owner"], env);
        expect(owner).toContain("Friday");
        expect(owner).not.toContain("SECRET");
        expect(owner).toContain("telegram:interactive chat:2");
      } finally { db.close(); rmSync(path, { force: true }); }
    });

    it("fails owner scope closed when the runtime cannot prove one owner", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("chat:1", "user", "evidence", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        const output = renderAgentBridgeContext(["--search", "evidence", "--scope", "owner"], { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "chat:1", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive" });
        expect(output).toContain("cannot mechanically prove one authenticated owner");
      } finally { db.close(); rmSync(path, { force: true }); }
    });

    it("preserves cross-conversation correction chronology and source provenance", () => {
      const { db, path } = makeDb();
      try {
        db.addConvTurn("topic:old", "user", "release decision is Thursday", "codex", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        db.addConvTurn("thread:new", "assistant", "correction release decision is Friday", "claude", { surfaceIdentity: "telegram:interactive", ownerKey: "owner-a" });
        const output = renderAgentBridgeContext(["--search", "release decision", "--scope", "owner"], { AGENT_BRIDGE_CONTEXT_DB: path, AGENT_BRIDGE_CHAT_KEY: "topic:old", AGENT_BRIDGE_SURFACE_IDENTITY: "telegram:interactive", AGENT_BRIDGE_OWNER_KEY: "owner-a" });
        expect(output.indexOf("Thursday")).toBeLessThan(output.indexOf("Friday"));
        expect(output).toContain("topic:old");
        expect(output).toContain("thread:new");
      } finally { db.close(); rmSync(path, { force: true }); }
    });

  });
});
