import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAcpProviderRuntime, runResolvedAcpProviderTurn, type AcpProviderPolicy } from "../src/providers/acpRuntime.js";
import type { InterimCommentarySignal } from "../src/acp/interimCommentary.js";

const policy: AcpProviderPolicy = {
  providerId: "fixture-acp",
  registryAgentId: "fixture-agent",
  presentation: { provisionalAnswers: true },
  authenticateMethodId: () => "workspace-token",
};
const fakeAgent = fileURLToPath(new URL("./support/fakeSecondAcpAgent.ts", import.meta.url));
const runtime = resolveAcpProviderRuntime(policy, {
  id: "fixture-agent", name: "Fixture Agent", version: "2.3.4",
  distribution: { npx: { package: "@example/fixture-agent@2.3.4" } },
}, { executable: process.execPath, args: [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), fakeAgent] });
const request = (prompt: string) => ({
  prompt, sessionId: null, command: process.execPath, model: null, executionMode: "safe" as const,
  outputFormat: "json" as const, soulContext: null, attachments: [], outputDir: null, effort: null, toolMode: "default" as const,
});

describe("live interim commentary from a real ACP stdio session", () => {
  const secret = "fixture-xai-secret-value";

  it("surfaces only protocol-eligible, safe commentary while the turn runs, then clears", async () => {
    const previous = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = secret;
    try {
      const signals: InterimCommentarySignal[] = [];
      const result = await runResolvedAcpProviderTurn(policy, runtime, request("COMMENTARY_PROBE"), process.cwd(), {
        bot: "grok", timeoutMs: 10_000, idleTimeoutMs: 10_000,
        onInterimCommentary: (signal) => signals.push(signal),
      }, { conversationId: "interim-conversation", runId: "interim-run" });
      expect(result.text).toContain("Final answer: the router is healthy.");
      expect(signals).toEqual([{ id: "1", text: "Reading the router configuration." }, { clear: 1 }]);
      const serialised = JSON.stringify(signals);
      for (const leaked of ["private chain of thought", "id_rsa", "TOKEN=", "child commentary", secret, "Final answer"]) {
        expect(serialised).not.toContain(leaked);
      }
    } finally {
      if (previous === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previous;
    }
  });

  it("emits nothing when the caller did not opt in", async () => {
    const result = await runResolvedAcpProviderTurn(policy, runtime, request("COMMENTARY_PROBE"), process.cwd(), {
      bot: "grok", timeoutMs: 10_000, idleTimeoutMs: 10_000,
    }, { conversationId: "interim-conversation-2", runId: "interim-run-2" });
    expect(result.text).toContain("Final answer");
  });
});
