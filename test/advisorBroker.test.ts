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

function setup(
  overrides: Record<string, string> = {},
  runCli = vi.fn().mockImplementation(async (command: string) => command.includes("codex")
    ? JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Independent view" } })
    : JSON.stringify({ result: "Independent view" })),
  abortCli?: (executionId: string) => Promise<boolean>,
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
    ...(abortCli ? { abortCli } : {}),
  } as any);
  return { broker, db, runCli, dir };
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
    });

    const output = await broker.requestWithCapability({
      capability,
      question: "What risk am I missing?",
      context: "The change removes an orchestration layer.",
    });

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

  it.each([
    { active: "claude", provider: "codex", command: "/trusted/codex", model: "gpt-5.6-sol" },
    { active: "agy", provider: "claude", command: "/trusted/claude", model: "claude-opus-5" },
  ])("returns one configured independent result to an active $active run", async ({ active, provider, command, model }) => {
    const { broker, db, runCli } = setup();
    const capability = broker.issue({
      chatKey: `chat:${active}`,
      cliKind: active,
      turnKey: `turn:${active}`,
      taskKey: `task:${active}`,
      repoPath: "/repo",
    });

    await expect(broker.requestWithCapability({
      capability,
      provider,
      question: "Give one independent view",
    })).resolves.toBe("Independent view");

    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][0]).toBe(command);
    expect(runCli.mock.calls[0][1]).toEqual(expect.arrayContaining(["--model", model]));
    const call = db.raw.prepare("SELECT selected_provider, selected_model, status FROM advisor_calls").get() as any;
    expect(call).toMatchObject({ selected_provider: provider, selected_model: model, status: "succeeded" });
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
    });

    await expect(broker.requestWithCapability({
      capability,
      provider: "claude",
      question: "Review this",
    })).rejects.toThrow(/independent provider/i);
    await expect(broker.requestWithCapability({
      capability,
      provider: "agy",
      question: "Review this",
    })).rejects.toThrow(/allowed advisor provider/i);
    expect(runCli).not.toHaveBeenCalled();
    db.close();
  });

  it("rejects an untrusted capability before invoking a provider", async () => {
    const { broker, db, runCli } = setup();
    await expect(broker.requestWithCapability({
      capability: "not-a-capability",
      question: "Review this",
    })).rejects.toThrow(/invalid capability/i);
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
    });

    await expect(broker.requestWithCapability({
      capability,
      provider: "claude",
      question: "One opinion only",
    })).rejects.toThrow(/provider unavailable/i);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][3]).toEqual(expect.objectContaining({ timeoutMs: 1234, advisorChild: true }));
    const attempts = db.raw.prepare("SELECT provider, status FROM advisor_attempts ORDER BY ordinal").all() as any[];
    expect(attempts).toEqual([{ provider: "claude", status: "failed" }]);
    db.close();
  });

  it("bounds caller context, output and per-turn invocation budget", async () => {
    const oversizedOutput = vi.fn().mockResolvedValue(JSON.stringify({ result: "x".repeat(16_001) }));
    const { broker, db } = setup({
      BRIDGE_ADVISOR_CONTEXT_MAX_CHARS: "32",
      BRIDGE_ADVISOR_MAX_CALLS_PER_TURN: "1",
    }, oversizedOutput);
    const capability = broker.issue({
      chatKey: "chat",
      cliKind: "codex",
      turnKey: "turn",
      taskKey: "task",
      repoPath: "/repo",
    });

    await expect(broker.requestWithCapability({
      capability,
      question: "Review",
      context: "c".repeat(33),
    })).rejects.toThrow(/context.*bound/i);
    expect(oversizedOutput).not.toHaveBeenCalled();

    await expect(broker.requestWithCapability({ capability, question: "Review" }))
      .rejects.toThrow(/output.*bound/i);
    expect(oversizedOutput).toHaveBeenCalledTimes(1);

    await expect(broker.requestWithCapability({ capability, question: "Again" }))
      .rejects.toThrow(/budget exhausted/i);
    expect(oversizedOutput).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("aborts the one advisor subprocess when its provider-side client disconnects", async () => {
    let rejectRun: ((error: Error) => void) | null = null;
    const runCli = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectRun = reject; }));
    const abortCli = vi.fn(async () => {
      rejectRun?.(new Error("advisor cancelled"));
      return true;
    });
    const { broker, db, dir } = setup({}, runCli, abortCli);
    await broker.start();
    const capability = broker.issue({
      chatKey: "chat",
      cliKind: "codex",
      turnKey: "turn",
      taskKey: "task",
      repoPath: "/repo",
    });
    const controller = new AbortController();
    const pending = requestAdvisorViaBroker(
      { capability, question: "Review" },
      process.env,
      dir,
      controller.signal,
    );

    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort|cancel/i);
    await vi.waitFor(() => expect(abortCli).toHaveBeenCalledTimes(1));
    expect(abortCli.mock.calls[0][0]).toMatch(/^advisor:/);

    await broker.close();
    db.close();
  });
});
