import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runResolvedAcpProviderTurn,
  type AcpProviderPolicy,
  type ResolvedProviderRuntime,
} from "../src/providers/acpRuntime.js";
import { readProviderFailureEvidence } from "../src/providers/failureEvidence.js";
import { decideProviderRecovery } from "../src/providers/recoveryVerdict.js";
import type { ProviderInvocationRequest } from "../src/providers/types.js";

const fixture = fileURLToPath(new URL("./support/scriptedAcpAgent.ts", import.meta.url));
const policy: AcpProviderPolicy = {
  providerId: "codex",
  registryAgentId: "codex-acp",
  presentation: { provisionalAnswers: true },
};
const runtime: ResolvedProviderRuntime = {
  providerId: "codex",
  transport: "acp-stdio",
  executable: process.execPath,
  args: [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), fixture],
  versionArgs: ["--version"],
  runtimeIdentity: "test:codex-scripted",
  selectedVersion: "test",
  registryAgentId: "codex-acp",
  distribution: null,
  toolFree: false,
  provisionalAnswers: true,
};
const request: ProviderInvocationRequest = {
  prompt: "do the task",
  sessionId: null,
  command: "codex-acp",
  model: null,
  executionMode: "trusted",
  outputFormat: "json",
  soulContext: null,
  includeResponseContract: false,
  attachments: [],
  outputDir: null,
  effort: null,
  toolMode: "default",
};

async function failureFor(mode: string, counter?: string, events: any[] = []): Promise<unknown> {
  process.env.SCRIPTED_ACP_MODE = mode;
  if (counter) process.env.SCRIPTED_ACP_COUNTER = counter;
  else delete process.env.SCRIPTED_ACP_COUNTER;
  try {
    await runResolvedAcpProviderTurn(
      policy,
      runtime,
      request,
      process.cwd(),
      {
        timeoutMs: 20_000,
        idleTimeoutMs: 20_000,
        chatId: `evidence-${mode}`,
        eventContext: { runId: `run-${mode}`, bot: "codex", chatId: "c", chatKey: "c" },
        onEvent: (event: any) => events.push(event),
      },
      { conversationId: `conv-${mode}`, runId: `run-${mode}` },
    );
  } catch (error) {
    return error;
  } finally {
    delete process.env.SCRIPTED_ACP_MODE;
    delete process.env.SCRIPTED_ACP_COUNTER;
  }
  throw new Error("expected provider failure");
}

describe("ACP prompt submission evidence at the runtime boundary", () => {
  it("tags an unclassified provider-owned setup failure without prompt submission", async () => {
    let error: unknown;
    try {
      await runResolvedAcpProviderTurn({
        ...policy,
        validateRuntime: () => { throw new Error("vendor runtime unavailable"); },
      }, runtime, request, process.cwd(), {
        timeoutMs: 20_000, idleTimeoutMs: 20_000,
      }, { conversationId: "setup", runId: "setup" });
    } catch (failure) { error = failure; }
    expect(readProviderFailureEvidence(error)).toEqual({ promptSubmitted: false });
    expect(decideProviderRecovery("codex", error as Error).reason).toBe("provider_transport_failure");
  });

  it("does not give an unreadable Bridge attachment provider provenance", async () => {
    let error: unknown;
    try {
      await runResolvedAcpProviderTurn(policy, runtime, {
        ...request, attachments: [join(tmpdir(), "missing-bridge-attachment-1281")],
      }, process.cwd(), { timeoutMs: 20_000, idleTimeoutMs: 20_000 }, { conversationId: "local", runId: "local" });
    } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error);
    expect(readProviderFailureEvidence(error)).toBeNull();
    expect(decideProviderRecovery("codex", error as Error).reason).toBeNull();
  });

  it("proves no submission when every attempt fails during session setup", async () => {
    const events: any[] = [];
    const error = await failureFor("setup-fail", undefined, events);
    expect(readProviderFailureEvidence(error)).toEqual({ promptSubmitted: false });
    expect(events.filter((event) => event.type === "run.diagnostic").map((event) => event.promptSubmitted))
      .toEqual([false, false]);
    expect(decideProviderRecovery("codex", error as Error).reason).toBe("provider_transport_failure");
  }, 30_000);

  it("retains prompt-submitted provenance without replaying a failed prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-evidence-"));
    try {
      const events: any[] = [];
      const error = await failureFor("prompt-then-setup-fail", join(dir, "count"), events);
      expect(readProviderFailureEvidence(error)).toMatchObject({ promptSubmitted: true, sessionId: expect.any(String) });
      // Attempt 1 submitted: do not launch another adapter process blindly.
      expect(events.filter((event) => event.type === "run.diagnostic").map((event) => event.promptSubmitted))
        .toEqual([true]);
      expect(decideProviderRecovery("codex", error as Error).reason).toBe("provider_transport_failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not replay in the ACP runtime before handing an unclassified submitted failure to a route owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-evidence-"));
    try {
      const events: any[] = [];
      const counter = join(dir, "count");
      const error = await failureFor("prompt-fail", counter, events);
      expect(readProviderFailureEvidence(error)).toMatchObject({ promptSubmitted: true, sessionId: expect.any(String) });
      // One adapter process only: the task is not replayed on an ambiguous failure.
      expect(readFileSync(counter, "utf8")).toBe("1");
      const diagnostics = events.filter((event) => event.type === "run.diagnostic");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({ attempt: 1, successorStarted: false, retryEligible: false, promptSubmitted: true });
      expect(decideProviderRecovery("codex", error as Error).reason).toBe("provider_transport_failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
