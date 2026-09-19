import { describe, expect, it } from "vitest";
import { buildAcpFailureDiagnosticEvent } from "../src/providers/acpFailureDiagnostic.js";

const eventContext = {
  runId: "run-diag",
  bot: "codex" as const,
  chatId: "-1003852297592",
  chatKey: "-1003852297592:86",
  threadId: "86",
};

describe("ACP failure diagnostics", () => {
  it("retains bounded concrete cause data while redacting provider credentials", () => {
    const error = new Error("bridge orchestration exploded with secret-diagnostic-key", {
      cause: new Error("provider handoff failed"),
    });
    const diagnostic = buildAcpFailureDiagnosticEvent("codex", error, eventContext, {
      CODEX_API_KEY: "secret-diagnostic-key",
    });

    expect(diagnostic).toMatchObject({
      type: "run.diagnostic",
      runId: "run-diag",
      bot: "codex",
      provider: "codex",
      chatId: "-1003852297592",
      chatKey: "-1003852297592:86",
      threadId: "86",
      boundary: "provider_execution",
      executionSurface: "acp",
      attempt: 1,
      successorStarted: false,
      retryEligible: false,
      classification: "unknown",
      fallbackEligible: false,
    });
    expect(diagnostic.message).toContain("bridge orchestration exploded");
    expect(diagnostic.message).toContain("provider handoff failed");
    expect(diagnostic.message).not.toContain("secret-diagnostic-key");
    expect(diagnostic.message).toContain("[REDACTED_PROVIDER_CREDENTIAL]");
  });

  it("records retry attempt state explicitly", () => {
    const diagnostic = buildAcpFailureDiagnosticEvent(
      "claude",
      new Error("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh."),
      { ...eventContext, bot: "claude" },
      {},
      { attempt: 1, successorStarted: true },
    );

    expect(diagnostic).toMatchObject({
      provider: "claude",
      executionSurface: "acp",
      attempt: 1,
      successorStarted: true,
      retryEligible: true,
      classification: "transient",
      fallbackEligible: false,
    });

    const cancelledDiagnostic = buildAcpFailureDiagnosticEvent(
      "claude",
      new Error("Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh."),
      { ...eventContext, bot: "claude" },
      {},
      { attempt: 1, successorStarted: false },
    );

    expect(cancelledDiagnostic).toMatchObject({
      provider: "claude",
      executionSurface: "acp",
      attempt: 1,
      successorStarted: false,
      retryEligible: true,
      classification: "transient",
      fallbackEligible: false,
    });
  });

  it("records capacity classification and fallback eligibility", () => {
    const diagnostic = buildAcpFailureDiagnosticEvent(
      "codex",
      new Error("MODEL_CAPACITY_EXHAUSTED"),
      eventContext,
      {},
    );

    expect(diagnostic).toMatchObject({
      type: "run.diagnostic",
      classification: "capacity_exhausted",
      fallbackEligible: true,
      retryEligible: false,
    });
  });

  it("includes structured ACP provider detail behind a generic top-level error", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { message: "You've hit your usage limit. Try again later." },
    });
    const diagnostic = buildAcpFailureDiagnosticEvent("codex", error, eventContext, {});

    expect(diagnostic.message).toContain("Internal error");
    expect(diagnostic.message).toContain("usage limit");
    expect(diagnostic.classification).toBe("capacity_exhausted");
  });

  it("retains bounded ACP data.details used by providers such as Antigravity", () => {
    const error = Object.assign(new Error("Internal error"), {
      data: { details: "Could not find default localharness binary. Set ANTIGRAVITY_HARNESS_PATH." },
    });
    const diagnostic = buildAcpFailureDiagnosticEvent("agy", error, {
      ...eventContext,
      bot: "antigravity",
    }, {});

    expect(diagnostic.message).toContain("Internal error");
    expect(diagnostic.message).toContain("localharness");
    expect(diagnostic.message).toContain("ANTIGRAVITY_HARNESS_PATH");
  });
});
