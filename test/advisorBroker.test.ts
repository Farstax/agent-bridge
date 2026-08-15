import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorBroker, requestAdvisorViaBroker } from "../src/advisorBroker.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "advisor-broker-"));
  dirs.push(dir);
  const db = openDb(join(dir, "bridge.sqlite"));
  const runCli = vi.fn().mockResolvedValue(JSON.stringify({
    advice_md: "Use the broker.", risks: [], suggested_next_steps: ["Verify"], confidence: "high",
  }));
  const broker = new AdvisorBroker({
    db,
    config: parseAdvisorConfig({
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_CHAIN: "claude:claude-fable-5,claude:claude-opus-4-8",
      ...overrides,
    }),
    bots: { claude: { command: "/trusted/claude", modelPreference: [] } },
    runCli,
    socketDir: dir,
  });
  return { broker, db, runCli };
}

describe("bridge-owned advisor broker", () => {
  it("binds trusted scope, identity, repository and budgets server-side", async () => {
    const { broker, db, runCli } = setup();
    await broker.start();
    const capability = broker.issue({
      chatKey: "chat:7", cliKind: "codex", turnKey: "turn-1", taskKey: "task-1",
      repoPath: "/trusted/repo", activeModel: "gpt-5.6-sol",
    });

    const output = await requestAdvisorViaBroker({ capability, mode: "review", task: "Review it" });

    expect(output).toContain("Use the broker.");
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--tools", ""]),
      "/trusted/repo",
      expect.objectContaining({ advisorChild: true }),
    );
    const call = db.raw.prepare("SELECT scope_key, turn_key, task_key, selected_provider FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ scope_key: "chat:7", turn_key: "turn-1", task_key: "task-1", selected_provider: "claude" });
    const attempt = db.raw.prepare("SELECT provider, model, status FROM advisor_attempts").get() as any;
    expect(attempt).toMatchObject({ provider: "claude", model: "claude-fable-5", status: "succeeded" });
    await broker.close();
    db.close();
  });

  it("ignores forged agent environment because the client sends only capability, mode and task", async () => {
    const { broker, db, runCli } = setup({ BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "1" });
    await broker.start();
    const capability = broker.issue({
      chatKey: "trusted-chat", cliKind: "codex", turnKey: "trusted-turn", taskKey: "trusted-task",
      repoPath: "/trusted/repo", activeModel: null,
    });
    const forged = {
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_CHAIN: "codex:attacker-model",
      BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "999",
      CODEX_COMMAND: "/attacker/codex",
      AGENT_BRIDGE_CHAT_KEY: "other-chat",
      AGENT_BRIDGE_CLI_KIND: "claude",
      AGENT_BRIDGE_ADVISOR_TURN_KEY: "fresh-turn",
    };

    await requestAdvisorViaBroker({ capability, mode: "review", task: "First" }, forged);
    await expect(requestAdvisorViaBroker({ capability, mode: "review", task: "Second" }, forged))
      .rejects.toThrow(/budget exhausted/i);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][0]).toBe("/trusted/claude");
    const call = db.raw.prepare("SELECT scope_key, turn_key FROM advisor_calls WHERE status='succeeded'").get() as any;
    expect(call).toMatchObject({ scope_key: "trusted-chat", turn_key: "trusted-turn" });
    await broker.close();
    db.close();
  });

  it("rejects altered, expired and previous-turn capabilities", async () => {
    let now = 1_000;
    const { broker, db, runCli } = setup();
    broker.setClockForTest(() => now);
    await broker.start();
    const first = broker.issue({
      chatKey: "chat", cliKind: "codex", turnKey: "turn-1", taskKey: "task-1", repoPath: "/repo", activeModel: null,
    });
    await expect(requestAdvisorViaBroker({ capability: `${first}x`, mode: "review", task: "x" })).rejects.toThrow(/invalid capability/i);
    const second = broker.issue({
      chatKey: "chat", cliKind: "codex", turnKey: "turn-2", taskKey: "task-2", repoPath: "/repo", activeModel: null,
    });
    await expect(requestAdvisorViaBroker({ capability: first, mode: "review", task: "x" })).rejects.toThrow(/invalid capability/i);
    now += 10 * 60_000 + 1;
    await expect(requestAdvisorViaBroker({ capability: second, mode: "review", task: "x" })).rejects.toThrow(/expired capability/i);
    expect(runCli).not.toHaveBeenCalled();
    await broker.close();
    db.close();
  });

  it("fails closed when the trusted chain contains a provider without tool-free mode", async () => {
    const { broker, db, runCli } = setup({ BRIDGE_ADVISOR_CHAIN: "unsupported:some-model" });
    await broker.start();
    expect(() => broker.issue({
      chatKey: "chat", cliKind: "claude", turnKey: "turn", taskKey: "task", repoPath: "/repo", activeModel: null,
    })).toThrow(/Advisor disabled or misconfigured/i);
    expect(runCli).not.toHaveBeenCalled();
    await broker.close();
    db.close();
  });
});
