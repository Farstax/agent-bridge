import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { executeAdvisorRequest } from "../src/advisor.js";
import { buildAdvisorContext, parseAdvisorOutput } from "../src/advisorPrompt.js";
import { shouldAllowAdvisorCall } from "../src/advisorPolicy.js";

describe("advisor configuration and policy", () => {
  afterEach(() => vi.restoreAllMocks());

  it("defaults off and parses two ordered provider/model targets", () => {
    expect(parseAdvisorConfig({})).toMatchObject({ enabled: false, mode: "manual", chain: [] });
    expect(parseAdvisorConfig({
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_MODE: "auto",
      BRIDGE_ADVISOR_CHAIN: "claude:fable-5,codex:gpt-5.6-luna,agy:ignored",
    })).toMatchObject({
      enabled: true,
      mode: "auto",
      chain: [
        { provider: "claude", model: "fable-5" },
        { provider: "codex", model: "gpt-5.6-luna" },
      ],
    });
  });

  it("allows explicit calls in manual mode and gates suggested/automatic calls", () => {
    expect(shouldAllowAdvisorCall("manual", "manual", false)).toBe(true);
    expect(shouldAllowAdvisorCall("manual", "manual", false)).toBe(true);
    expect(shouldAllowAdvisorCall("manual", "suggest", true)).toBe(false);
    expect(shouldAllowAdvisorCall("suggest", "suggest", false)).toBe(false);
    expect(shouldAllowAdvisorCall("suggest", "suggest", true)).toBe(true);
    expect(shouldAllowAdvisorCall("auto", "auto", false)).toBe(true);
  });
});

describe("advisor context and output", () => {
  it("builds bounded redacted context from summary and newest turns", () => {
    const db = openDb(":memory:");
    db.addConvTurn("chat", "user", "old text");
    db.addConvSummary("chat", 1, 1, "summary with token=secret-value");
    db.addConvTurn("chat", "assistant", "latest evidence");

    const context = buildAdvisorContext(db, {
      scopeKey: "chat",
      task: "Review this",
      maxChars: 120,
    });

    expect(context).toContain("Review this");
    expect(context).toContain("latest evidence");
    expect(context).not.toContain("secret-value");
    expect(context.length).toBeLessThanOrEqual(120);
    db.close();
  });

  it("accepts strict structured output and rejects malformed output", () => {
    expect(parseAdvisorOutput(JSON.stringify({
      advice_md: "Use the smaller change.",
      risks: ["Regression"],
      suggested_next_steps: ["Add a test"],
      confidence: "high",
    }))).toMatchObject({ adviceMd: "Use the smaller change.", confidence: "high" });
    expect(() => parseAdvisorOutput("not json")).toThrow(/invalid advisor output/i);
    expect(() => parseAdvisorOutput(JSON.stringify({ advice_md: "x", risks: [], suggested_next_steps: [], confidence: "certain" })))
      .toThrow(/invalid advisor output/i);
  });
});

describe("advisor request execution", () => {
  it("clears the advisor timeout after a fast provider result", async () => {
    vi.useFakeTimers();
    const db = openDb(":memory:");
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      advice_md: "Proceed.", risks: [], suggested_next_steps: [], confidence: "high",
    }));

    await executeAdvisorRequest({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:fable-5",
      }),
      request: {
        requestId: "req-timeout-cleanup", scopeKey: "chat", turnKey: "chat:cleanup", origin: "manual",
        mode: "review", task: "Review", activeProvider: "codex", activeModel: null,
      },
      bots: { claude: { command: "claude", modelPreference: [] } },
      runCli,
      cwd: "/repo",
      executionProfile: "tool_free",
    });

    expect(vi.getTimerCount()).toBe(0);
    db.close();
    vi.useRealTimers();
  });

  it("falls back once on operational failure and never persists an advisor session", async () => {
    const db = openDb(":memory:");
    db.setSession("chat", "codex", "executor-session");
    const runCli = vi.fn()
      .mockRejectedValueOnce(new Error("Authentication required: please log in"))
      .mockResolvedValueOnce(JSON.stringify({
        advice_md: "Proceed with tests.", risks: [], suggested_next_steps: ["Run suite"], confidence: "high",
      }));

    const result = await executeAdvisorRequest({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:fable-5,claude:opus-4-8",
      }),
      request: {
        requestId: "req-1", scopeKey: "chat", turnKey: "chat:10", origin: "manual",
        mode: "review", task: "Review", activeProvider: "codex", activeModel: "gpt-5.5",
      },
      bots: {
        claude: { command: "claude", modelPreference: [] },
      },
      runCli,
      cwd: "/repo",
      executionProfile: "tool_free",
    });

    expect(result.provider).toBe("claude");
    expect(result.model).toBe("opus-4-8");
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(db.getSession("chat", "codex")).toBe("executor-session");
    expect(db.getAdvisorAttempts("req-1")).toHaveLength(2);
    db.close();
  });

  it("enforces one logical request per turn atomically", async () => {
    const db = openDb(":memory:");
    const config = parseAdvisorConfig({
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_CHAIN: "claude:fable-5",
      BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "1",
    });
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      advice_md: "Advice", risks: [], suggested_next_steps: [], confidence: "medium",
    }));
    const base = {
      db, config, bots: { claude: { command: "claude", modelPreference: [] } }, runCli, cwd: "/repo",
      executionProfile: "tool_free" as const,
    };

    await executeAdvisorRequest({ ...base, request: {
      requestId: "req-a", scopeKey: "chat", turnKey: "turn", origin: "manual" as const,
      mode: "review" as const, task: "First", activeProvider: "claude", activeModel: null,
    }});
    await expect(executeAdvisorRequest({ ...base, request: {
      requestId: "req-b", scopeKey: "chat", turnKey: "turn", origin: "manual" as const,
      mode: "review" as const, task: "Second", activeProvider: "claude", activeModel: null,
    }})).rejects.toThrow(/budget exhausted/i);

    expect(runCli).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("uses the secondary target when the primary returns invalid output", async () => {
    const db = openDb(":memory:");
    const runCli = vi.fn()
      .mockResolvedValueOnce("not structured")
      .mockResolvedValueOnce(JSON.stringify({
        advice_md: "Recovered advice", risks: [], suggested_next_steps: [], confidence: "medium",
      }));
    const result = await executeAdvisorRequest({
      db,
      config: parseAdvisorConfig({ BRIDGE_ADVISOR_ENABLED: "true", BRIDGE_ADVISOR_CHAIN: "claude:fable-5,claude:opus-4-8" }),
      request: {
        requestId: "invalid-fallback", scopeKey: "chat", turnKey: "invalid-turn", origin: "manual",
        mode: "review", task: "Review", activeProvider: "codex", activeModel: null,
      },
      bots: {
        claude: { command: "claude", modelPreference: [] },
      },
      runCli,
      cwd: "/repo",
      executionProfile: "tool_free",
    });
    expect(result.adviceMd).toBe("Recovered advice");
    expect(result.provider).toBe("claude");
    expect(result.model).toBe("opus-4-8");
    db.close();
  });
});
