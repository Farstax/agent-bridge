import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import { CliTimeoutError, ProviderStallError } from "../src/cli.js";
import { classifyProviderError } from "../src/providers/errorClassification.js";
import {
  attachProviderFailureEvidence,
  readProviderFailureEvidence,
} from "../src/providers/failureEvidence.js";
import { decideProviderRecovery } from "../src/providers/recoveryVerdict.js";

const weeklyLimit = "You've hit your weekly limit · resets 11am (Europe/London)";

function tagged(message: string, promptSubmitted: boolean): Error {
  return attachProviderFailureEvidence(new Error(message), { promptSubmitted });
}

describe("Claude weekly limit (2026-10-10 incident)", () => {
  it("is capacity exhausted for Claude by its own pattern, not by another provider's wording", () => {
    expect(classifyProviderError("claude", weeklyLimit).kind).toBe("capacity_exhausted");
  });

  it("requests capacity fallback instead of a same-session generic retry", () => {
    const decision = decideProviderRecovery("claude", new Error(weeklyLimit));
    expect(decision.reason).toBe("capacity");
    expect(decision.freshSessionRetry).toBe(false);
  });
});

describe("provider recovery verdict", () => {
  it("makes an unclassified provider failure eligible only when no prompt was ever submitted", () => {
    expect(decideProviderRecovery("codex", tagged("Internal error: boom", false)).reason)
      .toBe("provider_transport_failure");
    expect(decideProviderRecovery("codex", tagged("Internal error: boom", true)).reason).toBeNull();
  });

  it("never treats an untagged unknown error as a provider failure", () => {
    expect(decideProviderRecovery("codex", new Error("Internal error: boom")).reason).toBeNull();
    expect(decideProviderRecovery("codex", new Error("ordinary repository failure")).reason).toBeNull();
  });

  it("keeps submission evidence monotonic across attempts of the same admitted action", () => {
    const laterSetupFailure = tagged("Internal error: setup failed", false);
    const earlier = readProviderFailureEvidence(tagged("first attempt died", true));
    expect(decideProviderRecovery("codex", laterSetupFailure, earlier).reason).toBeNull();
  });

  it("preserves the existing categorical routes regardless of submission evidence", () => {
    expect(decideProviderRecovery("codex", tagged("usage limit reached", true)).reason).toBe("capacity");
    expect(decideProviderRecovery("claude", tagged("Failed to authenticate", true)).reason).toBe("auth_required");
    expect(decideProviderRecovery("claude", tagged("model \"x\" not found", true)).reason).toBe("capacity");
    expect(decideProviderRecovery("codex", new Error("socket hang up")).reason).toBe("provider_transport_failure");
    expect(decideProviderRecovery("codex", new Error("socket hang up")).freshSessionRetry).toBe(true);
    expect(decideProviderRecovery("codex", new ProviderStallError("stalled")).reason).toBe("provider_stall");
    expect(decideProviderRecovery("codex", new CliTimeoutError("t", "hard")).reason).toBeNull();
    expect(decideProviderRecovery("codex", attachProviderFailureEvidence(new CliTimeoutError("t", "hard"), { promptSubmitted: false })).reason)
      .toBe("provider_transport_failure");
    expect(decideProviderRecovery("codex", attachProviderFailureEvidence(new CliTimeoutError("t", "hard"), { promptSubmitted: true })).reason)
      .toBeNull();
    expect(decideProviderRecovery("codex", new Error("spawn agent ENOENT")).reason).toBe("provider_unavailable");
  });

  it("does not make Claude OAuth refresh contention a transport retry", () => {
    const decision = decideProviderRecovery(
      "claude",
      new Error("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh."),
    );
    expect(decision.reason).toBe("auth_required");
  });
});

describe("ACP prompt submission evidence", () => {
  it("reports submission immediately before session/prompt and not when setup fails first", async () => {
    const submitted = vi.fn();
    const peer = acp.agent({ name: "evidence-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "evidence-session" }))
      .onRequest(acp.methods.agent.session.prompt, async () => ({ stopReason: "end_turn" }));
    await runAcpTurn({
      peer,
      cwd: process.cwd(),
      conversationId: "c",
      runId: "r",
      prompt: "hi",
      executionMode: "trusted",
      onPromptSubmitted: submitted,
    } as any);
    expect(submitted).toHaveBeenCalledTimes(1);

    const setupFails = vi.fn();
    const failing = acp.agent({ name: "setup-failure-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(acp.methods.agent.session.new, async () => { throw new Error("session setup exploded"); });
    await expect(runAcpTurn({
      peer: failing,
      cwd: process.cwd(),
      conversationId: "c",
      runId: "r2",
      prompt: "hi",
      executionMode: "trusted",
      onPromptSubmitted: setupFails,
    } as any)).rejects.toThrow();
    expect(setupFails).not.toHaveBeenCalled();
  });
});
