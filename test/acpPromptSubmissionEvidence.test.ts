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
  it("proves no submission when every attempt fails during session setup", async () => {
    const events: any[] = [];
    const error = await failureFor("setup-fail", undefined, events);
    expect(readProviderFailureEvidence(error)).toEqual({ promptSubmitted: false });
    expect(events.filter((event) => event.type === "run.diagnostic").map((event) => event.promptSubmitted))
      .toEqual([false, false]);
    expect(decideProviderRecovery("codex", error as Error).reason).toBe("provider_transport_failure");
  }, 30_000);

  it("does not reset to pre-prompt when the retry attempt fails during setup after attempt 1 submitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-evidence-"));
    try {
      const events: any[] = [];
      const error = await failureFor("prompt-then-setup-fail", join(dir, "count"), events);
      expect(readProviderFailureEvidence(error)).toEqual({ promptSubmitted: true });
      // Attempt 1 submitted; the later setup failure must not be recorded as pre-prompt.
      expect(events.filter((event) => event.type === "run.diagnostic").map((event) => event.promptSubmitted))
        .toEqual([true, true]);
      expect(decideProviderRecovery("codex", error as Error).reason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("does not start a successor attempt for an unclassified failure after prompt submission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-evidence-"));
    try {
      const events: any[] = [];
      const counter = join(dir, "count");
      const error = await failureFor("prompt-fail", counter, events);
      expect(readProviderFailureEvidence(error)).toEqual({ promptSubmitted: true });
      // One adapter process only: the task is not replayed on an ambiguous failure.
      expect(readFileSync(counter, "utf8")).toBe("1");
      expect(decideProviderRecovery("codex", error as Error).reason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
