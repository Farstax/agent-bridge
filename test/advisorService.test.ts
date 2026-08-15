import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorBroker } from "../src/advisorBroker.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { AdvisorService } from "../src/advisorService.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(chain = "claude:claude-fable-5,claude:claude-opus-4-8") {
  const db = openDb(":memory:");
  const runCli = vi.fn().mockResolvedValue(JSON.stringify({
    advice_md: "Unified advice.", risks: ["One risk"], suggested_next_steps: ["Next"], confidence: "high",
  }));
  const service = new AdvisorService({
    db,
    config: parseAdvisorConfig({ BRIDGE_ADVISOR_ENABLED: "true", BRIDGE_ADVISOR_CHAIN: chain }),
    bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
    runCli,
  });
  return { db, runCli, service };
}

describe("unified advisor service", () => {
  it("executes manual requests tool-free through the shared execution path", async () => {
    const { db, runCli, service } = setup();
    const result = await service.requestTrusted({
      origin: "manual", scopeKey: "chat:1", turnKey: "turn-1", mode: "review", task: "Review it",
      activeProvider: "codex", activeModel: null, cwd: "/repo",
    });
    expect(result.adviceMd).toBe("Unified advice.");
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    db.close();
  });

  it("executes bounded evidence requests through the same tool-free path", async () => {
    const { db, runCli, service } = setup();
    await service.requestTrusted({
      origin: "manual", scopeKey: "manual:task-9", taskKey: "task-9", mode: "plan", task: "Plan it",
      activeProvider: "codex", activeModel: null, cwd: "/tmp/repo",
      evidence: { diffSummary: "diff", testOutput: "tests" },
    });
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/tmp/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    const call = db.raw.prepare("SELECT scope_key, task_key, trigger FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ scope_key: "manual:task-9", task_key: "task-9", trigger: "manual" });
    db.close();
  });

  it("rejects chains containing providers without tool-free mode before consuming budget", async () => {
    const { db, runCli, service } = setup("unsupported:some-model");
    await expect(service.requestTrusted({
      origin: "manual", scopeKey: "chat:1", turnKey: "turn-1", mode: "review", task: "Review it",
      activeProvider: "codex", activeModel: null, cwd: "/repo",
    })).rejects.toThrow(/no configured targets/i);
    expect(runCli).not.toHaveBeenCalled();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM advisor_calls").get()).toMatchObject({ n: 0 });
    db.close();
  });

  it("broker capability requests resolve into the same trusted execution in-process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-service-"));
    dirs.push(dir);
    const db = openDb(join(dir, "bridge.sqlite"));
    const runCli = vi.fn().mockResolvedValue(JSON.stringify({
      advice_md: "Broker advice.", risks: [], suggested_next_steps: [], confidence: "medium",
    }));
    const broker = new AdvisorBroker({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:claude-fable-5,claude:claude-opus-4-8",
      }),
      bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
      runCli,
      socketDir: dir,
    });
    const capability = broker.issue({
      chatKey: "chat:7", cliKind: "codex", turnKey: "turn-1", taskKey: "task-1",
      repoPath: "/trusted/repo", activeModel: null,
    });

    const output = await broker.requestWithCapability({ capability, mode: "review", task: "Review it" });

    expect(output).toContain("Broker advice.");
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/trusted/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    const call = db.raw.prepare("SELECT scope_key, turn_key, task_key FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ scope_key: "chat:7", turn_key: "turn-1", task_key: "task-1" });
    await broker.close();
    db.close();
  });

  it("uses bounded repository evidence for a manual request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-service-read-tools-"));
    dirs.push(dir);
    writeFileSync(join(dir, "README.md"), "Current repository evidence: bounded reads are enabled.\n");
    const db = openDb(":memory:");
    const runCli = vi.fn().mockImplementation(async (_command: string, args: string[]) => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({
          hypothesis: "Inspect the current repository documentation",
          tool_requests: [{ tool: "repo.read_file", path: "README.md" }],
          missing_evidence: [],
        });
      }
      expect(args.join(" ")).toContain("Current repository evidence: bounded reads are enabled.");
      return JSON.stringify({
        advice_md: "The repository confirms bounded advisor reads are enabled.",
        risks: [],
        suggested_next_steps: [],
        confidence: "high",
      });
    });
    const service = new AdvisorService({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:claude-fable-5",
      }),
      bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
      runCli,
    });

    const result = await service.requestTrusted({
      origin: "manual",
      scopeKey: "chat:read-tools",
      turnKey: "turn-read-tools",
      mode: "review",
      task: "Review the repository read-tool state",
      activeProvider: "codex",
      activeModel: null,
      cwd: dir,
    });

    expect(result.adviceMd).toContain("bounded advisor reads");
    expect(runCli).toHaveBeenCalledTimes(2);
    for (const [, args] of runCli.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(["--tools", ""]));
    }
    db.close();
  });

  it("keeps manual debug requests on the ordinary advisor result contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-service-manual-debug-"));
    dirs.push(dir);
    writeFileSync(join(dir, "README.md"), "Manual debug evidence.\n");
    const db = openDb(":memory:");
    const runCli = vi.fn().mockImplementation(async () => {
      if (runCli.mock.calls.length === 1) {
        return JSON.stringify({
          hypothesis: "Inspect the current repository documentation",
          tool_requests: [],
          missing_evidence: [],
        });
      }
      return JSON.stringify({
        verdict: "needs_human",
        advice_md: "Manual debugging guidance.",
        risks: [],
        suggested_next_steps: ["Inspect the reported behavior"],
        verification_steps: [],
        evidence_ids: [],
        evidence_basis: [],
        assumptions: [],
        unresolved_conflicts: [],
        confidence: "medium",
      });
    });
    const service = new AdvisorService({
      db,
      config: parseAdvisorConfig({
        BRIDGE_ADVISOR_ENABLED: "true",
        BRIDGE_ADVISOR_CHAIN: "claude:claude-fable-5",
      }),
      bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
      runCli,
    });

    const result = await service.requestTrusted({
      origin: "manual",
      scopeKey: "chat:manual-debug",
      turnKey: "turn-manual-debug",
      mode: "debug",
      task: "Debug the reported behavior",
      activeProvider: "codex",
      activeModel: null,
      cwd: dir,
    });

    expect(result).toMatchObject({
      adviceMd: "Manual debugging guidance.",
      suggestedNextSteps: ["Inspect the reported behavior"],
      confidence: "medium",
    });
    expect(result.verdict).toBe("needs_human");
    expect(runCli).toHaveBeenCalledTimes(2);
    db.close();
  });
});
