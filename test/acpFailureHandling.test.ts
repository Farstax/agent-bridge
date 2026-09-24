import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import { runAcpTurn } from "../src/acp/client.js";
import {
  createClaudeAcpAnswerPreview,
  detectClaudeAcpTurnError,
} from "../src/providers/claudeAcpPolicy.js";
import {
  classifyProviderError,
  isClaudeOAuthRefreshContention,
} from "../src/providers/errorClassification.js";
import {
  CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS,
  runWithAcpTransientRetry,
} from "../src/providers/acpTransientRetry.js";

const refreshContention =
  "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.";
const refreshContentionWithoutPeriod = refreshContention.slice(0, -1);

function systemErrorAgent(diagnostic: string): acp.AgentApp {
  return acp.agent({ name: "system-error-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-system-error" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          threadStatus: { type: "systemError" },
        } as any,
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: diagnostic },
        },
      });
      return { stopReason: "end_turn" };
    });
}

function usageLimitedAgent(statusType: "usageLimited" | "budgetLimited", diagnostic: string): acp.AgentApp {
  return acp.agent({ name: "usage-limited-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-usage-limited" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "session_info_update",
          threadStatus: { type: statusType },
        } as any,
      });
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: diagnostic },
        },
      });
      return { stopReason: "end_turn" };
    });
}

function claudeRateLimitRejectedAgent(requestFailureMessage: string): acp.AgentApp {
  return acp.agent({ name: "claude-rate-limit-agent" })
    .onRequest(acp.methods.agent.initialize, async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {},
    }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-claude-rate-limit" }))
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 0,
          size: 0,
          _meta: { "_claude/rateLimit": { status: "rejected" } },
        } as any,
      });
      throw new Error(requestFailureMessage);
    });
}

function claudeMessageEvent(text: string): any {
  return {
    kind: "session_update",
    channel: "live",
    acpSessionId: "claude-session",
    sessionMode: "fresh",
    notification: {
      sessionId: "claude-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  };
}

describe("ACP provider failure handling", () => {
  it("turns an in-band ACP systemError into a provider error before answer reconciliation", async () => {
    const retained: any[] = [];
    const liveText: string[] = [];
    let thrown: unknown;

    try {
      await runAcpTurn({
        peer: systemErrorAgent("You've hit your usage limit. Try again at 1:48 PM."),
        cwd: process.cwd(),
        conversationId: "conv-system-error",
        runId: "run-system-error",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
        onLiveText: (text) => liveText.push(text),
        onEvent: (event) => retained.push(event),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AcpSystemError");
    expect((thrown as Error).message).toContain("usage limit");
    expect(classifyProviderError("codex", thrown as Error)).toMatchObject({ kind: "capacity_exhausted" });
    expect(liveText).toEqual([]);
    expect(retained.some((event) => event.notification?.update?.sessionUpdate === "session_info_update")).toBe(true);
    expect(retained.some((event) => event.presentationSuppressed === true
      && event.notification?.update?.sessionUpdate === "agent_message_chunk")).toBe(true);
  });

  it("keeps an unknown ACP systemError fail-closed rather than promoting its text to an answer", async () => {
    let thrown: unknown;
    try {
      await runAcpTurn({
        peer: systemErrorAgent("provider had an unclassified internal condition"),
        cwd: process.cwd(),
        conversationId: "conv-system-error-unknown",
        runId: "run-system-error-unknown",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(classifyProviderError("codex", thrown as Error)).toMatchObject({ kind: "unknown" });
  });

  for (const statusType of ["usageLimited", "budgetLimited"] as const) {
    it(`classifies an in-band ACP ${statusType} thread status as capacity_exhausted from the structured signal alone`, async () => {
      let thrown: unknown;
      // Deliberately does not contain any CAPACITY_PATTERNS/TRANSIENT_PATTERNS
      // wording -- this must classify as capacity_exhausted purely because
      // Codex's own threadStatus said so, not because of text matching.
      const diagnostic = "Please wait a moment before your next message.";

      try {
        await runAcpTurn({
          peer: usageLimitedAgent(statusType, diagnostic),
          cwd: process.cwd(),
          conversationId: `conv-${statusType}`,
          runId: `run-${statusType}`,
          existingAcpSessionId: null,
          prompt: "hello",
          executionMode: "trusted",
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(classifyProviderError("codex", thrown as Error)).toMatchObject({ kind: "capacity_exhausted" });
    });
  }

  it("classifies a Claude request failure as capacity_exhausted when preceded by a rate-limit 'rejected' status, even with ambiguous error text", async () => {
    let thrown: unknown;
    // Deliberately ambiguous -- would classify as "unknown" for claude on
    // text alone (doesn't match any CAPACITY_PATTERNS.claude/AUTH/etc entry).
    const ambiguousMessage = "the request could not be completed";

    try {
      await runAcpTurn({
        peer: claudeRateLimitRejectedAgent(ambiguousMessage),
        cwd: process.cwd(),
        conversationId: "conv-claude-rate-limit",
        runId: "run-claude-rate-limit",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(classifyProviderError("claude", thrown as Error)).toMatchObject({ kind: "capacity_exhausted" });
  });

  it("leaves an ordinary Claude request failure unclassified when no rate-limit 'rejected' status preceded it", async () => {
    let thrown: unknown;
    const agent = acp.agent({ name: "claude-ordinary-failure-agent" })
      .onRequest(acp.methods.agent.initialize, async () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: "acp-claude-ordinary" }))
      .onRequest(acp.methods.agent.session.prompt, async () => {
        throw new Error("the request could not be completed");
      });

    try {
      await runAcpTurn({
        peer: agent,
        cwd: process.cwd(),
        conversationId: "conv-claude-ordinary",
        runId: "run-claude-ordinary",
        existingAcpSessionId: null,
        prompt: "hello",
        executionMode: "trusted",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(classifyProviderError("claude", thrown as Error)).toMatchObject({ kind: "unknown" });
  });

  it("classifies Claude OAuth refresh contention as transient in direct and structured error shapes", () => {
    const direct = new Error(refreshContention);
    const structured = Object.assign(new Error("Internal error"), {
      data: { message: refreshContention },
    });

    for (const error of [direct, structured]) {
      expect(isClaudeOAuthRefreshContention(error)).toBe(true);
      expect(classifyProviderError("claude", error)).toMatchObject({ kind: "transient" });
    }
  });

  it("converts only a diagnostic-shaped Claude refresh message into a retryable execution error", () => {
    const error = detectClaudeAcpTurnError({
      liveText: refreshContention,
    } as any);
    expect(error).toBeInstanceOf(Error);
    expect(isClaudeOAuthRefreshContention(error!)).toBe(true);

    expect(detectClaudeAcpTurnError({ liveText: "ordinary Claude answer" } as any)).toBeNull();
    expect(detectClaudeAcpTurnError({
      liveText: `I can explain this message: ${refreshContention}`,
    } as any)).toBeNull();
  });

  it("keeps exact and split Claude refresh contention out of provisional answer previews", () => {
    for (const diagnostic of [refreshContention, refreshContentionWithoutPeriod]) {
      const chunks: string[] = [];
      const preview = createClaudeAcpAnswerPreview((text) => chunks.push(text), []);
      preview.observe(claudeMessageEvent(diagnostic));
      preview.finish("end_turn");
      expect(chunks).toEqual([]);
    }

    const splitChunks: string[] = [];
    const splitPreview = createClaudeAcpAnswerPreview((text) => splitChunks.push(text), []);
    splitPreview.observe(claudeMessageEvent("Failed to refresh OAuth token: another Claude Code process is "));
    splitPreview.observe(claudeMessageEvent("refreshing it or exited mid-refresh. This is usually transient."));
    splitPreview.finish("end_turn");
    expect(splitChunks).toEqual([]);

    const ordinary: string[] = [];
    const normalPreview = createClaudeAcpAnswerPreview((text) => ordinary.push(text), []);
    normalPreview.observe(claudeMessageEvent("Final answer"));
    normalPreview.finish("end_turn");
    expect(ordinary.join("")).toBe("Final answer");
  });

  it("retries Claude OAuth refresh contention once and records that the successor actually starts", async () => {
    const wait = vi.fn(async () => {});
    const decision = vi.fn(async () => {});
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error(refreshContention))
      .mockResolvedValueOnce("ok");

    await expect(runWithAcpTransientRetry("claude", operation, {
      wait,
      abortRequested: () => false,
      onRetryDecision: decision,
    })).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(CLAUDE_OAUTH_REFRESH_RETRY_DELAY_MS, expect.any(Function));
    expect(decision).toHaveBeenCalledTimes(1);
    expect(decision.mock.calls[0][1]).toBe(true);
    expect(decision.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("does not retry unrelated Claude failures and records when cancellation prevents a successor", async () => {
    const unrelated = vi.fn().mockRejectedValue(new Error("Authentication required: please log in"));
    await expect(runWithAcpTransientRetry("claude", unrelated, {
      wait: vi.fn(async () => {}),
      abortRequested: () => false,
    })).rejects.toThrow(/Authentication required/);
    expect(unrelated).toHaveBeenCalledTimes(1);

    let abort = false;
    const operation = vi.fn().mockRejectedValue(new Error(refreshContention));
    const wait = vi.fn(async (_delay: number, _abortRequested: () => boolean) => {
      abort = true;
    });
    const decision = vi.fn(async () => {});
    await expect(runWithAcpTransientRetry("claude", operation, {
      wait,
      abortRequested: () => abort,
      onRetryDecision: decision,
    })).rejects.toThrow(/cancelled before transient retry/i);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(decision).toHaveBeenCalledTimes(1);
    expect(decision.mock.calls[0][1]).toBe(false);
  });
});
