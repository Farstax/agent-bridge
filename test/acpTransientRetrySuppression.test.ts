import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Exercises runResolvedAcpProviderTurn's own retry wrapping (runWithAcpTransientRetry)
// for real -- this is the layer a mocked runProviderInvocation (as in
// test/transientSameProviderFreshSessionRetry.test.ts) bypasses entirely, which is
// exactly why that test could not catch tier 2 unintentionally re-triggering tier 1's
// retry on its fresh-session attempt. Mock only the two collaborators that would
// otherwise spawn a real child process and speak real ACP wire protocol
// (runSupervisedStdioSession, runAcpTurn) so the retry-count assertions are fast and
// deterministic, while runResolvedAcpProviderTurn's own control flow runs unmocked.
const runSupervisedStdioSessionMock = vi.fn(
  async (_executable: string, _args: string[], _cwd: string, _options: unknown, callback: (io: unknown) => unknown) =>
    callback({ stdin: new PassThrough(), stdout: new PassThrough(), signal: undefined }),
);
vi.mock("../src/cliSupervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cliSupervisor.js")>();
  return { ...actual, runSupervisedStdioSession: runSupervisedStdioSessionMock };
});

const runAcpTurnMock = vi.fn();
vi.mock("../src/acp/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/acp/client.js")>();
  return { ...actual, runAcpTurn: runAcpTurnMock };
});

describe("tier-2 fresh-session retry does not re-trigger tier 1's own retry", () => {
  let policy: import("../src/providers/acpRuntime.js").AcpProviderPolicy;
  let runtime: import("../src/providers/acpRuntime.js").ResolvedProviderRuntime;

  beforeEach(async () => {
    runSupervisedStdioSessionMock.mockClear();
    runAcpTurnMock.mockReset();
    const { resolveAcpProviderRuntime } = await import("../src/providers/acpRuntime.js");
    policy = { providerId: "codex", registryAgentId: "codex-agent", presentation: { provisionalAnswers: true } };
    runtime = resolveAcpProviderRuntime(policy, {
      id: "codex-agent",
      name: "Codex Agent",
      version: "1.0.0",
      distribution: { npx: { package: "@example/codex-agent@1.0.0" } },
    }, { executable: process.execPath, args: [] });
  });

  function fixtureRequest() {
    return {
      prompt: "answer",
      sessionId: null,
      command: process.execPath,
      model: null,
      executionMode: "safe" as const,
      outputFormat: "json" as const,
      soulContext: null,
      attachments: [],
      outputDir: null,
      effort: null,
    };
  }

  it("without suppression: a persistent transient failure is retried once internally (tier 1's own 2-attempt behavior, unaffected)", async () => {
    runAcpTurnMock.mockRejectedValue(new Error("Selected model is at capacity. Please try a different model."));
    const { runResolvedAcpProviderTurn } = await import("../src/providers/acpRuntime.js");

    await expect(runResolvedAcpProviderTurn(
      policy, runtime, fixtureRequest(), process.cwd(),
      { bot: "codex", timeoutMs: 5_000, idleTimeoutMs: 5_000 },
      { conversationId: "conv-1", runId: "run-1" },
    )).rejects.toThrow();

    // Tier 1's existing, unmodified behavior: exactly one retry (2 total attempts).
    expect(runAcpTurnMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("with suppressTransientRetry: a persistent transient failure is attempted exactly once, no internal retry", async () => {
    runAcpTurnMock.mockRejectedValue(new Error("Selected model is at capacity. Please try a different model."));
    const { runResolvedAcpProviderTurn } = await import("../src/providers/acpRuntime.js");

    await expect(runResolvedAcpProviderTurn(
      policy, runtime, fixtureRequest(), process.cwd(),
      { bot: "codex", timeoutMs: 5_000, idleTimeoutMs: 5_000, suppressTransientRetry: true },
      { conversationId: "conv-2", runId: "run-2" },
    )).rejects.toThrow();

    // This is the fix under test: tier 2's fresh-session attempt must not
    // re-trigger tier 1's own same-session retry.
    expect(runAcpTurnMock).toHaveBeenCalledTimes(1);
  });

  it("with suppressTransientRetry: succeeds normally on a single attempt when the fresh session recovers", async () => {
    runAcpTurnMock.mockResolvedValue({
      conversationId: "conv-3",
      runId: "run-3",
      acpSessionId: "fresh-session",
      sessionMode: "fresh",
      stopReason: "end_turn",
      liveText: "recovered",
      events: [],
      updates: [],
      configOptions: [],
      staleSessionConfig: [],
      initialize: { protocolVersion: 1, agentCapabilities: {} },
    });
    const { runResolvedAcpProviderTurn } = await import("../src/providers/acpRuntime.js");

    const result = await runResolvedAcpProviderTurn(
      policy, runtime, fixtureRequest(), process.cwd(),
      { bot: "codex", timeoutMs: 5_000, idleTimeoutMs: 5_000, suppressTransientRetry: true },
      { conversationId: "conv-3", runId: "run-3" },
    );

    expect(result.text).toBe("recovered");
    expect(runAcpTurnMock).toHaveBeenCalledTimes(1);
  });
});
