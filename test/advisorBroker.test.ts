import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdvisorBroker } from "../src/advisorBroker.js";
import { parseAdvisorConfig } from "../src/advisorConfig.js";
import { openDb } from "../src/db.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  overrides: Record<string, string> = {},
  runCli = vi.fn().mockResolvedValue(JSON.stringify({ result: "Independent view" })),
) {
  const dir = mkdtempSync(join(tmpdir(), "advisor-broker-"));
  dirs.push(dir);
  const db = openDb(join(dir, "bridge.sqlite"));
  const broker = new AdvisorBroker({
    db,
    config: parseAdvisorConfig({
      BRIDGE_ADVISOR_ENABLED: "true",
      BRIDGE_ADVISOR_CHAIN: "claude:claude-opus-5,codex:gpt-5.6-sol",
      ...overrides,
    }),
    bots: {
      claude: { command: "/trusted/claude", modelPreference: [] },
      codex: { command: "/trusted/codex", modelPreference: [] },
    },
    runCli,
    socketDir: dir,
  });
  return { broker, db, runCli };
}

describe("bounded cross-provider frontier advice", () => {
  it("uses one allowed provider different from the active provider and records minimal audit", async () => {
    const { broker, db, runCli } = setup();
    const capability = broker.issue({
      chatKey: "chat:7",
      cliKind: "codex",
      turnKey: "turn-1",
      taskKey: "task-1",
      repoPath: "/trusted/repo",
      activeModel: "gpt-5.6-sol",
    });

    const output = await broker.requestWithCapability({
      capability,
      question: "What risk am I missing?",
      context: "The change removes an orchestration layer.",
    } as any);

    expect(output).toBe("Independent view");
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli).toHaveBeenCalledWith(
      "/trusted/claude",
      expect.arrayContaining(["--model", "claude-opus-5", "--tools", ""]),
      "/trusted/repo",
      expect.objectContaining({ advisorChild: true, timeoutMs: expect.any(Number), chatId: expect.stringMatching(/^advisor:/) }),
    );
    const call = db.raw.prepare("SELECT scope_key, turn_key, task_key, selected_provider, selected_model, status FROM advisor_calls").get() as any;
    expect(call).toMatchObject({
      scope_key: "chat:7",
      turn_key: "turn-1",
      task_key: "task-1",
      selected_provider: "claude",
      selected_model: "claude-opus-5",
      status: "succeeded",
    });
    const attempts = db.raw.prepare("SELECT provider, model, status FROM advisor_attempts ORDER BY ordinal").all() as any[];
    expect(attempts).toEqual([{ provider: "claude", model: "claude-opus-5", status: "succeeded" }]);
    db.close();
  });

  it("accepts only a configured independent provider and never lets the caller choose its own provider", async () => {
    const { broker, db, runCli } = setup();
    const capability = broker.issue({
      chatKey: "chat",
      cliKind: "claude",
      turnKey: "turn",
      taskKey: "task",
      repoPath: "/repo",
      activeModel: "claude-opus-5",
    });

    await expect(broker.requestWithCapability({
      capability,
      provider: "claude",
      question: "Review this",
    } as any)).rejects.toThrow(/independent provider/i);
    await expect(broker.requestWithCapability({
      capability,
      provider: "agy",
      question: "Review this",
    } as any)).rejects.toThrow(/allowed advisor provider/i);
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("makes exactly one provider call with the configured timeout and does not fall back on failure", async () => {
    const runCli = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const { broker, db } = setup({ BRIDGE_ADVISOR_TIMEOUT_MS: "1234" }, runCli);
    const capability = broker.issue({
      chatKey: "chat",
      cliKind: "agy",
      turnKey: "turn",
      taskKey: "task",
      repoPath: "/repo",
      activeModel: null,
    });

    await expect(broker.requestWithCapability({
      capability,
      provider: "claude",
      question: "One opinion only",
    } as any)).rejects.toThrow(/provider unavailable/i);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][3]).toEqual(expect.objectContaining({ timeoutMs: 1234, advisorChild: true }));
    const attempts = db.raw.prepare("SELECT provider, status FROM advisor_attempts ORDER BY ordinal").all() as any[];
    expect(attempts).toEqual([{ provider: "claude", status: "failed" }]);
    db.close();
  });

  it("bounds caller context, output and per-turn invocation budget", async () => {
    const oversizedOutput = vi.fn().mockResolvedValue(JSON.stringify({ result: "x".repeat(65) }));
    const { broker, db } = setup({
      BRIDGE_ADVISOR_CONTEXT_MAX_CHARS: "32",
      BRIDGE_ADVISOR_OUTPUT_MAX_CHARS: "64",
      BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "1",
    }, oversizedOutput);
    const capability = broker.issue({
      chatKey: "chat",
      cliKind: "codex",
      turnKey: "turn",
      taskKey: "task",
      repoPath: "/repo",
      activeModel: null,
    });

    await expect(broker.requestWithCapability({
      capability,
      question: "Review",
      context: "c".repeat(33),
    } as any)).rejects.toThrow(/context.*bound/i);
    expect(oversizedOutput).not.toHaveBeenCalled();

    await expect(broker.requestWithCapability({ capability, question: "Review" } as any))
      .rejects.toThrow(/output.*bound/i);
    expect(oversizedOutput).toHaveBeenCalledTimes(1);

    await expect(broker.requestWithCapability({ capability, question: "Again" } as any))
      .rejects.toThrow(/budget exhausted/i);
    expect(oversizedOutput).toHaveBeenCalledTimes(1);
    db.close();
  });
});
